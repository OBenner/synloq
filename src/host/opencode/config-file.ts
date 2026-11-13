import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "../../config/atomic-file.js";
import { SynloqError } from "../../domain/errors.js";

export interface OpencodeLocalMcpServer {
  type: "local";
  command: string[];
  enabled: boolean;
}

function invalid(message: string): never {
  throw new SynloqError("INVALID_INPUT", message);
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`opencode.json ${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

// Non-destructive merge: foreign keys are preserved, only the supplied
// mcp.servers entries are written; re-running with the same entries is a
// byte-identical no-op. Broken or non-object existing JSON fails loud.
export async function mergeOpencodeMcpServers(
  projectRoot: string,
  servers: Record<string, OpencodeLocalMcpServer>,
): Promise<string> {
  const path = join(projectRoot, "opencode.json");
  let existing: unknown = {};
  try {
    existing = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      existing = {};
    } else if (error instanceof SyntaxError) {
      invalid("opencode.json contains malformed JSON");
    } else {
      throw error;
    }
  }
  const root = asRecord(existing, "root");
  const mcp = root.mcp === undefined ? {} : asRecord(root.mcp, "mcp");
  const current = mcp.servers === undefined ? {} : asRecord(mcp.servers, "mcp.servers");
  for (const [name, server] of Object.entries(servers)) {
    current[name] = { type: server.type, command: server.command, enabled: server.enabled };
  }
  mcp.servers = current;
  root.mcp = mcp;
  await writeJsonAtomic(path, root, 0o644);
  return path;
}
