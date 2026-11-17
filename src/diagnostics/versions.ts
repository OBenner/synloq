import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { SynloqError } from "../domain/errors.js";
import { PROTOCOL_VERSION } from "../domain/session.js";

/** node:sqlite is experimental in Node 22 and stable from 24 — the engines floor. */
export const MINIMUM_NODE_MAJOR = 24;

export function isSupportedNode(version: string): boolean {
  const major = Number(/^v?(\d+)/.exec(version)?.[1]);
  return Number.isInteger(major) && major >= MINIMUM_NODE_MAJOR;
}

/**
 * Fail-loud runtime gate (issue #111): on an old Node the first DB open would
 * crash opaquely. Commands that write (init, serve) call this BEFORE any
 * write; the message names the requirement and states nothing was written.
 */
export function assertSupportedNode(version: string = process.version): void {
  if (isSupportedNode(version)) return;
  throw new SynloqError(
    "INVALID_INPUT",
    `Synloq requires Node.js ${MINIMUM_NODE_MAJOR} or newer (node:sqlite is required); ` +
      `this process runs ${version}. Install Node 24+ and retry — nothing was written.`,
  );
}

export interface VersionsBlock {
  synloq: string;
  node: string;
  /** Issue #111: whether the running Node satisfies the node:sqlite floor. */
  nodeSupported: boolean;
  protocol: number;
  schema?: number;
  /** Host/CLI versions where detectable; absent = undetected (fail soft). */
  hosts: { kimiWork?: string; opencode?: string; codex?: string };
}

/**
 * Version telemetry (#115): one copy-pasteable block so external bug reports
 * are reproducible. Every probe fails soft — a missing CLI or an unreadable
 * file yields "unknown"/absent, never an error. No network calls: host
 * versions come from local `--version` invocations with bounded timeouts.
 */
export async function collectVersions(options: {
  databasePath: string;
  probe?: HostVersionProbe;
  /** Test hook: evaluate a runtime other than the running process. */
  nodeVersion?: string;
}): Promise<VersionsBlock> {
  const node = options.nodeVersion ?? process.version;
  let hosts: VersionsBlock["hosts"] = {};
  try {
    hosts = await (options.probe ?? defaultHostProbe)();
  } catch {
    // Fail soft (#115): undetectable host versions must never break the report.
  }
  return {
    synloq: await synloqVersion(),
    node,
    nodeSupported: isSupportedNode(node),
    protocol: PROTOCOL_VERSION,
    ...schemaVersion(options.databasePath),
    hosts,
  };
}

async function synloqVersion(): Promise<string> {
  try {
    // dist/diagnostics/versions.js -> ../../../package.json at the package root.
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = await readFile(join(here, "..", "..", "..", "package.json"), "utf8");
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === "string" ? version : "unknown";
  } catch {
    return "unknown";
  }
}

function schemaVersion(databasePath: string): { schema?: number } {
  try {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = database.prepare("PRAGMA user_version").get() as
        { user_version: number } | undefined;
      return { schema: row?.user_version ?? 0 };
    } finally {
      database.close();
    }
  } catch {
    return {};
  }
}

export type HostVersionProbe = () => Promise<VersionsBlock["hosts"]>;

function runVersion(command: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), 3_000);
    execFile(command, args, { timeout: 3_000, windowsHide: true }, (error, stdout) => {
      clearTimeout(timer);
      if (error) return resolve(undefined);
      const line = stdout.trim().split(/\r?\n/)[0]?.trim();
      resolve(line === undefined || line === "" ? undefined : line.slice(0, 120));
    });
  });
}

const defaultHostProbe: HostVersionProbe = async () => {
  const [kimiWork, opencode, codex] = await Promise.all([
    runVersion("kimi-work", ["--version"]),
    runVersion("opencode", ["--version"]),
    runVersion("codex", ["--version"]),
  ]);
  return {
    ...(kimiWork ? { kimiWork } : {}),
    ...(opencode ? { opencode } : {}),
    ...(codex ? { codex } : {}),
  };
};
