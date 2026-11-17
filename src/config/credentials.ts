import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { SynloqError } from "../domain/errors.js";
import { agentId as agentIdSchema } from "../domain/message.js";
import type { SecurityAuditLog } from "../relay/audit-log.js";
import type { TokenProvider } from "../transport/http-client.js";
import { writeJsonAtomic, writeTextAtomic } from "./atomic-file.js";
import { projectPaths } from "./paths.js";
import { withFileLock } from "./file-lock.js";
import { keyId } from "../transport/auth-proof.js";

interface CredentialEntry {
  agentId: string;
  tokenHash: string;
}

interface CredentialFile {
  version: 1;
  project: string;
  entries: CredentialEntry[];
}

export interface Identity {
  project: string;
  agentId: string;
  operator: boolean;
}

export interface EnsuredCredential {
  token: string;
  tokenPath: string;
  reused: boolean;
}

function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

/**
 * Token provider backed by the credential file (UX task: recovery after a
 * 401/token reissue). Re-reads the file on every call so a `rotate-token` or
 * `doctor --repair` reissue takes effect in a running channel without a
 * process restart. A transient read failure (Windows sharing violation, a
 * torn rename mid-rewrite) must not break a live channel: the last
 * successfully read token is returned instead. `knownTokens` accumulates
 * every token ever served so diagnostics can mask old and new alike.
 */
export function createTokenFileProvider(
  tokenPath: string,
  initial: string,
): { provider: TokenProvider; knownTokens: () => string[] } {
  let lastGood = initial;
  const known = new Set<string>(initial === "" ? [] : [initial]);
  return {
    provider: async () => {
      try {
        const token = (await readFile(tokenPath, "utf8")).trim();
        if (token !== "") {
          lastGood = token;
          known.add(token);
        }
      } catch {
        // Fall through to the last good token: a momentary read failure must
        // not drop a working channel.
      }
      if (lastGood === "") {
        throw new SynloqError(
          "INVALID_INPUT",
          `credential file is empty or unreadable: ${tokenPath}`,
        );
      }
      return lastGood;
    },
    knownTokens: () => [...known],
  };
}

export class CredentialStore {
  constructor(
    private readonly projectRoot: string,
    private readonly synloqHome?: string,
    private readonly audit?: SecurityAuditLog,
  ) {}

  /**
   * Credential lifecycle audit (issue #3, M4-min): issue/rotate/revoke are
   * accept events — they are the actions an incident review looks for. The
   * detail never carries token material, only hash counts.
   */
  private record(
    action: "issue" | "rotate" | "revoke",
    project: string,
    agentId: string,
    reasonCode: string,
    detail: string,
  ): void {
    this.audit?.record({
      at: new Date().toISOString(),
      project,
      agentId,
      action,
      decision: "accept",
      reasonCode,
      detail,
    });
  }

  async issue(project: string, agentId: string): Promise<string> {
    const paths = await projectPaths(this.projectRoot, this.synloqHome);
    return withFileLock(paths.credentials, () =>
      this.issueLocked(paths.credentials, project, agentId),
    );
  }

  /** Caller holds the project credential lock, including any later token write. */
  private async issueLocked(path: string, project: string, agentId: string): Promise<string> {
    const credentials = await this.read(path, project);
    if (credentials.project !== project) {
      throw new SynloqError("INVALID_INPUT", "credential project does not match stored project");
    }
    const token = randomBytes(32).toString("base64url");
    credentials.entries.push({ agentId, tokenHash: tokenDigest(token).toString("hex") });
    await writeJsonAtomic(path, credentials);
    this.record("issue", project, agentId, "ISSUED", "credential issued");
    return token;
  }

  /**
   * Replaces every stored hash of the agent with a fresh token: previously
   * issued tokens stop authenticating immediately. The new token is written
   * to the agent's token file; the caller never receives it in plain output.
   */
  async rotate(
    project: string,
    agentId: string,
  ): Promise<{ token: string; tokenPath: string; replacedHashes: number }> {
    agentIdSchema.parse(agentId);
    const paths = await projectPaths(this.projectRoot, this.synloqHome);
    return withFileLock(paths.credentials, async () => {
      const credentials = await this.read(paths.credentials, project);
      if (credentials.project !== project) {
        throw new SynloqError("INVALID_INPUT", "credential project does not match stored project");
      }
      const replacedHashes = credentials.entries.filter(
        (entry) => entry.agentId === agentId,
      ).length;
      if (replacedHashes === 0) {
        throw new SynloqError("INVALID_INPUT", "no existing credential to rotate for this agent");
      }
      const token = randomBytes(32).toString("base64url");
      credentials.entries = [
        ...credentials.entries.filter((entry) => entry.agentId !== agentId),
        { agentId, tokenHash: tokenDigest(token).toString("hex") },
      ];
      await writeJsonAtomic(paths.credentials, credentials);
      const tokenPath = join(paths.tokens, `${agentId}.token`);
      await writeTextAtomic(tokenPath, `${token}\n`);
      this.record(
        "rotate",
        project,
        agentId,
        "ROTATED",
        `credential rotated; ${replacedHashes} stored hash(es) replaced`,
      );
      return { token, tokenPath, replacedHashes };
    });
  }

  /**
   * Removes every stored hash of the agent without issuing a new token.
   * Idempotent: revoking an agent with no stored credentials succeeds with
   * zero removed hashes.
   */
  async revoke(
    project: string,
    agentId: string,
  ): Promise<{ removedHashes: number; tokenPath: string }> {
    agentIdSchema.parse(agentId);
    const paths = await projectPaths(this.projectRoot, this.synloqHome);
    return withFileLock(paths.credentials, async () => {
      const credentials = await this.read(paths.credentials, project);
      if (credentials.project !== project) {
        throw new SynloqError("INVALID_INPUT", "credential project does not match stored project");
      }
      const removedHashes = credentials.entries.filter((entry) => entry.agentId === agentId).length;
      credentials.entries = credentials.entries.filter((entry) => entry.agentId !== agentId);
      await writeJsonAtomic(paths.credentials, credentials);
      const tokenPath = join(paths.tokens, `${agentId}.token`);
      await rm(tokenPath, { force: true });
      this.record(
        "revoke",
        project,
        agentId,
        "REVOKED",
        `credential revoked; ${removedHashes} stored hash(es) removed`,
      );
      return { removedHashes, tokenPath };
    });
  }

  /**
   * Offline credential health check for doctor (issue #6): "ok" when the
   * token file authenticates as the same agent, "missing" when the file is
   * absent or empty, "stale" when the token no longer authenticates (e.g.
   * after a rotation elsewhere) or belongs to a different agent.
   */
  async inspect(
    project: string,
    agentId: string,
  ): Promise<{ tokenPath: string; status: "ok" | "missing" | "stale" }> {
    agentIdSchema.parse(agentId);
    const paths = await projectPaths(this.projectRoot, this.synloqHome);
    const tokenPath = join(paths.tokens, `${agentId}.token`);
    let token: string;
    try {
      token = (await readFile(tokenPath, "utf8")).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { tokenPath, status: "missing" };
      }
      throw error;
    }
    if (!token) return { tokenPath, status: "missing" };
    try {
      const identity = await this.authenticate(project, token);
      return { tokenPath, status: identity.agentId === agentId ? "ok" : "stale" };
    } catch (error) {
      if (error instanceof SynloqError && error.code === "UNAUTHORIZED") {
        return { tokenPath, status: "stale" };
      }
      throw error;
    }
  }

  async ensureCredential(project: string, agentId: string): Promise<EnsuredCredential> {
    agentIdSchema.parse(agentId);
    const paths = await projectPaths(this.projectRoot, this.synloqHome);
    return withFileLock(paths.credentials, async () => {
      const tokenPath = join(paths.tokens, `${agentId}.token`);
      try {
        const token = (await readFile(tokenPath, "utf8")).trim();
        if (token) {
          const identity = await this.authenticate(project, token);
          if (identity.agentId === agentId) return { token, tokenPath, reused: true };
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          if (!(error instanceof SynloqError && error.code === "UNAUTHORIZED")) throw error;
        }
      }

      const token = await this.issueLocked(paths.credentials, project, agentId);
      await writeTextAtomic(tokenPath, `${token}\n`);
      return { token, tokenPath, reused: false };
    });
  }

  async authenticate(project: string, token: string): Promise<Identity> {
    const paths = await projectPaths(this.projectRoot, this.synloqHome);
    const credentials = await this.read(paths.credentials, project);
    const candidate = tokenDigest(token);
    if (credentials.project === project) {
      for (const entry of credentials.entries) {
        const stored = Buffer.from(entry.tokenHash, "hex");
        if (stored.length === candidate.length && timingSafeEqual(stored, candidate)) {
          return { project, agentId: entry.agentId, operator: entry.agentId === "operator" };
        }
      }
    }
    throw new SynloqError("UNAUTHORIZED", "invalid project credential");
  }

  /** Internal transport verifier. Never serialize or log the returned material. */
  async proofCredential(
    project: string,
    kid: string,
  ): Promise<{ identity: Identity; verifier: string }> {
    const paths = await projectPaths(this.projectRoot, this.synloqHome);
    const credentials = await this.read(paths.credentials, project);
    if (credentials.project === project && /^[a-f0-9]{64}$/.test(kid)) {
      for (const entry of credentials.entries) {
        const context = { project, agentId: entry.agentId };
        if (
          /^[a-f0-9]{64}$/.test(entry.tokenHash) &&
          timingSafeEqual(
            Buffer.from(keyId(entry.tokenHash, context), "hex"),
            Buffer.from(kid, "hex"),
          )
        ) {
          return {
            identity: { ...context, operator: entry.agentId === "operator" },
            verifier: entry.tokenHash,
          };
        }
      }
    }
    throw new SynloqError("UNAUTHORIZED", "unknown_kid");
  }

  private async read(path: string, project: string): Promise<CredentialFile> {
    try {
      return JSON.parse(await readFile(path, "utf8")) as CredentialFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, project, entries: [] };
      }
      throw error;
    }
  }
}
