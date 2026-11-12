import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { SynloqError } from "../domain/errors.js";
import { agentId as agentIdSchema } from "../domain/message.js";
import { writeJsonAtomic, writeTextAtomic } from "./atomic-file.js";
import { projectPaths } from "./paths.js";

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

export class CredentialStore {
  constructor(
    private readonly projectRoot: string,
    private readonly synloqHome?: string,
  ) {}

  async issue(project: string, agentId: string): Promise<string> {
    const paths = await projectPaths(this.projectRoot, this.synloqHome);
    const credentials = await this.read(paths.credentials, project);
    if (credentials.project !== project) {
      throw new SynloqError("INVALID_INPUT", "credential project does not match stored project");
    }
    const token = randomBytes(32).toString("base64url");
    credentials.entries.push({ agentId, tokenHash: tokenDigest(token).toString("hex") });
    await writeJsonAtomic(paths.credentials, credentials);
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
    const credentials = await this.read(paths.credentials, project);
    if (credentials.project !== project) {
      throw new SynloqError("INVALID_INPUT", "credential project does not match stored project");
    }
    const replacedHashes = credentials.entries.filter((entry) => entry.agentId === agentId).length;
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
    return { token, tokenPath, replacedHashes };
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
    const credentials = await this.read(paths.credentials, project);
    if (credentials.project !== project) {
      throw new SynloqError("INVALID_INPUT", "credential project does not match stored project");
    }
    const removedHashes = credentials.entries.filter((entry) => entry.agentId === agentId).length;
    credentials.entries = credentials.entries.filter((entry) => entry.agentId !== agentId);
    await writeJsonAtomic(paths.credentials, credentials);
    const tokenPath = join(paths.tokens, `${agentId}.token`);
    await rm(tokenPath, { force: true });
    return { removedHashes, tokenPath };
  }

  async ensureCredential(project: string, agentId: string): Promise<EnsuredCredential> {
    agentIdSchema.parse(agentId);
    const paths = await projectPaths(this.projectRoot, this.synloqHome);
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

    const token = await this.issue(project, agentId);
    await writeTextAtomic(tokenPath, `${token}\n`);
    return { token, tokenPath, reused: false };
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
