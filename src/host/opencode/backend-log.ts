import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Issue #92: the OpenCode backend service outlives the desktop GUI and never
 * retries a failed MCP server until the backend restarts. The last per-server
 * state is visible in the backend log — doctor surfaces it as
 * "MCP server failed, backend restart required".
 *
 * Log line shapes (observed on OpenCode Desktop 2.2.7, 2026-11-16):
 *   timestamp=… level=INFO … message="mcp connected" server=synloq-cto tools=6 …
 *   timestamp=… level=WARN … message="mcp connect failed" server=synloq-arch status.status=failed status.error="…"
 *   timestamp=… level=WARN … message="mcp transport error" server=synloq-arch error="…"
 *
 * Sanitization contract: only the server name, state, timestamp and a
 * narrowly extracted exit code leave this module. The raw error text (a
 * child-process stderr tail) is never returned — it may carry paths or
 * unexpected payloads.
 */

export interface OpenCodeMcpServerState {
  server: string;
  state: "connected" | "failed";
  at: string;
  /** Exit code of the MCP child process when the log line carries one. */
  exitCode?: number;
}

export interface OpenCodeBackendLogOptions {
  environment?: NodeJS.ProcessEnv;
  /** Injectable tail reader for tests; reads at most maxBytes from the end. */
  readTail?: (path: string, maxBytes: number) => Promise<string>;
  maxBytes?: number;
}

const DEFAULT_TAIL_BYTES = 256 * 1024;

export function openCodeBackendLogPath(environment: NodeJS.ProcessEnv = process.env): string {
  const home = environment.HOME ?? environment.USERPROFILE ?? homedir();
  const dataHome = environment.XDG_DATA_HOME ?? join(home, ".local", "share");
  return join(dataHome, "opencode", "log", "opencode.log");
}

async function defaultReadTail(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    let text = buffer.toString("utf8");
    if (start > 0) {
      // The first line of a tail chunk may be cut mid-line; drop it.
      const firstNewline = text.indexOf("\n");
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
    }
    return text;
  } finally {
    await handle.close();
  }
}

const MESSAGE = /message="(mcp connected|mcp connect failed|mcp transport error)"/;
const SERVER = /(?:^|\s)server=(synloq-[^\s"]+)/;
const TIMESTAMP = /^timestamp=(\S+)/;
// Narrow on purpose: only the child exit code is surfaced, nothing else from
// the error payload.
const EXIT_CODE = /process exited with code (\d+)/;

/**
 * Last known MCP state per synloq-* server, latest log event wins.
 * Offline-safe: a missing or unreadable log yields an empty map.
 */
export async function readOpenCodeMcpStates(
  options: OpenCodeBackendLogOptions = {},
): Promise<Map<string, OpenCodeMcpServerState>> {
  const path = openCodeBackendLogPath(options.environment);
  const readTail = options.readTail ?? defaultReadTail;
  let tail: string;
  try {
    tail = await readTail(path, options.maxBytes ?? DEFAULT_TAIL_BYTES);
  } catch {
    return new Map();
  }

  const states = new Map<string, OpenCodeMcpServerState>();
  for (const line of tail.split("\n")) {
    const message = MESSAGE.exec(line);
    if (!message) continue;
    const server = SERVER.exec(line);
    if (!server) continue;
    const timestamp = TIMESTAMP.exec(line);
    const entry: OpenCodeMcpServerState = {
      server: server[1]!,
      state: message[1] === "mcp connected" ? "connected" : "failed",
      at: timestamp?.[1] ?? "",
    };
    const exitCode = EXIT_CODE.exec(line);
    if (exitCode) entry.exitCode = Number(exitCode[1]);
    states.set(entry.server, entry);
  }
  return states;
}
