import { appendFile, mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { probeProcess } from "../relay/serve-lock.js";
import { projectPaths } from "../config/paths.js";

/**
 * Standalone relay supervisor (issue #166): a scheduled task calls this every
 * few minutes. Health is the only source of truth — a live relay means
 * instant exit. A genuinely unavailable relay is started detached, exactly
 * once per cooldown window. The serve lock (.serve.lock) is never read or
 * touched: stale-lock recovery belongs to the relay code itself (#141).
 */

export interface RelaySupervisorOptions {
  projectRoot: string;
  synloqHome?: string;
  relayUrl?: string;
  /** Injectable probes for tests. */
  probeHealth?: (relayUrl: string) => Promise<boolean>;
  startRelay?: (options: { projectRoot: string; port: number }) => void;
  probePid?: (pid: number) => "alive" | "dead" | "unknown";
  now?: () => number;
}

export type RelaySupervisorOutcome =
  "healthy" | "started" | "start-failed" | "cooldown" | "already-starting";

const PROBE_TIMEOUT_MS = 3_000;
const COOLDOWN_MS = 10 * 60_000;
const LOG_LINE_CAP = 200;

async function defaultProbeHealth(relayUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${relayUrl}/v1/health`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { service?: unknown };
    return body.service === "synloq-relay";
  } catch {
    return false;
  }
}

function defaultStartRelay(options: { projectRoot: string; port: number }): void {
  const cli = fileURLToPath(new URL("./main.js", import.meta.url));
  const child: ChildProcess = spawn(
    process.execPath,
    [cli, "serve", "--project-root", options.projectRoot, "--port", String(options.port)],
    { cwd: options.projectRoot, detached: true, stdio: "ignore", windowsHide: true },
  );
  child.unref();
}

/** Append one line, then trim the log back to the last LOG_LINE_CAP lines. */
async function appendBoundedLog(path: string, line: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${line}\n`, "utf8");
  const text = await readFile(path, "utf8");
  const lines = text.trim().split("\n");
  if (lines.length > LOG_LINE_CAP) {
    await writeFile(path, `${lines.slice(-LOG_LINE_CAP).join("\n")}\n`, "utf8");
  }
}

export async function runRelaySupervisor(
  options: RelaySupervisorOptions,
): Promise<RelaySupervisorOutcome> {
  const relayUrl = options.relayUrl ?? "http://127.0.0.1:4100";
  const port = Number(new URL(relayUrl).port) || 4100;
  const probeHealth = options.probeHealth ?? defaultProbeHealth;
  const startRelay = options.startRelay ?? defaultStartRelay;
  const probePid = options.probePid ?? probeProcess;
  const now = options.now ?? (() => Date.now());

  const paths = await projectPaths(options.projectRoot, options.synloqHome);
  const lockPath = `${paths.database}.relay-supervisor.lock`;
  const cooldownPath = `${paths.database}.relay-supervisor.cooldown`;
  const logPath = `${paths.database}.relay-supervisor.log`;
  const log = (message: string) =>
    appendBoundedLog(logPath, `${new Date(now()).toISOString()} ${message}`);

  if (await probeHealth(relayUrl)) return "healthy";

  // Cooldown: a broken relay must not respawn on every scheduled tick.
  try {
    const marker = JSON.parse(await readFile(cooldownPath, "utf8")) as { at?: number };
    if (typeof marker.at === "number" && now() - marker.at < COOLDOWN_MS) {
      await log("skip: cooldown after the last start attempt");
      return "cooldown";
    }
  } catch {
    // No marker or an unreadable one — proceed.
  }

  // Atomic claim: exactly one supervisor instance starts the relay.
  await mkdir(dirname(lockPath), { recursive: true });
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // A stale supervisor lock (dead claimant) is cleaned up; a live one wins.
    let ownerPid: number | undefined;
    try {
      const owner = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: number };
      ownerPid = typeof owner.pid === "number" ? owner.pid : undefined;
    } catch {
      ownerPid = undefined;
    }
    if (ownerPid !== undefined && probePid(ownerPid) === "dead") {
      await rm(lockPath, { force: true });
      await log(`removed stale supervisor lock (pid ${ownerPid})`);
      handle = await open(lockPath, "wx", 0o600);
    } else {
      await log("skip: another supervisor start is in flight");
      return "already-starting";
    }
  }

  try {
    await handle.writeFile(
      `${JSON.stringify({ pid: process.pid, at: new Date(now()).toISOString() })}\n`,
    );
    // Record the attempt before starting: a crash mid-start still cools down.
    await writeFile(cooldownPath, `${JSON.stringify({ at: now() })}\n`, "utf8");
    startRelay({ projectRoot: options.projectRoot, port });
    await log(`relay was unreachable; started detached serve on port ${port}`);
    return "started";
  } catch (error) {
    await log(
      `start failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200),
    );
    return "start-failed";
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
}
