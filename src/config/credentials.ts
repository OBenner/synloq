import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { SynloqError } from "../domain/errors.js";
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

function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export class CredentialStore {
  constructor(private readonly projectRoot: string) {}

  async issue(project: string, agentId: string): Promise<string> {
    const paths = await projectPaths(this.projectRoot);
    const credentials = await this.read(paths.credentials, project);
    const token = randomBytes(32).toString("base64url");
    credentials.entries.push({ agentId, tokenHash: tokenDigest(token).toString("hex") });

    await mkdir(dirname(paths.credentials), { recursive: true });
    const temporary = `${paths.credentials}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(credentials, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporary, paths.credentials);
    } finally {
      await rm(temporary, { force: true });
    }
    return token;
  }

  async authenticate(project: string, token: string): Promise<Identity> {
    const paths = await projectPaths(this.projectRoot);
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
