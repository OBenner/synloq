import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isPermissionError, permissionDenied, SynloqError } from "../domain/errors.js";

export type ProcessState = "alive" | "dead" | "unknown";
export function probeProcess(
  pid: number,
  kill: (pid: number, signal: 0) => unknown = process.kill,
): ProcessState {
  try {
    kill(pid, 0);
    return "alive";
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ESRCH" ? "dead" : "unknown";
  }
}
export interface ServeLockOptions {
  /** Synchronous, deterministic liveness probe; unknown never authorizes recovery. */
  probePid?: (pid: number) => ProcessState;
  onDiagnostic?: (message: string) => void;
}
export interface ServeLock {
  path: string;
  release(): Promise<void>;
}

/**
 * Serialize file transitions across processes, including recovery and release.
 * SQLite's OS lock is released on death, unlike a second potentially stale PID lock.
 * This sidecar has no application schema; the main DB is never opened/migrated here.
 * Never unlink the sidecar: replacing its inode would split the mutex domain.
 * No await is allowed inside this short synchronous transaction.
 */
function locked<T>(path: string, action: () => T): T {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(`${path}.mutex.sqlite`);
    db.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE");
    try {
      const result = action();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } catch (error) {
    if (error instanceof SynloqError || isPermissionError(error)) throw error;
    const failure = new SynloqError(
      "STORAGE_FAILURE",
      "Synloq serve lock transition failed; check lock-directory permissions and the persistent SQLite mutex sidecar. Do not delete a live relay's lock or mutex.",
    );
    failure.cause = error;
    throw failure;
  } finally {
    db?.close();
  }
}
function ownerText(path: string): string | undefined {
  try {
    if (statSync(path).size > 4096) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}
function ownerPid(text: string | undefined): number | undefined {
  try {
    const pid: unknown = JSON.parse(text ?? "").pid;
    return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Steal only on verified-dead (ESRCH); no age or PID-reuse heuristics. */
export async function acquireServeLock(
  databasePath: string,
  options: ServeLockOptions = {},
): Promise<ServeLock> {
  const path = `${databasePath}.serve.lock`;
  const record = `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), ownerId: randomUUID() })}\n`;
  const create = () => {
    const fd = openSync(path, "wx", 0o600);
    try {
      writeFileSync(fd, record);
    } finally {
      closeSync(fd);
    }
  };
  let recovered: number | undefined;
  try {
    mkdirSync(dirname(path), { recursive: true });
    try {
      create();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      locked(path, () => {
        // A previous owner may have released while we waited for the mutex.
        try {
          create();
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        const pid = ownerPid(ownerText(path));
        let state: ProcessState = "unknown";
        try {
          if (pid !== undefined) state = (options.probePid ?? probeProcess)(pid);
        } catch {
          /* fail closed */
        }
        if (pid === undefined || state !== "dead") {
          throw new SynloqError(
            "ALREADY_RUNNING",
            `Synloq relay unreachable or starting: another synloq serve owns this project database (lock ${path}, owner ${pid === undefined ? "unreadable/invalid" : `"pid":${pid}`}, liveness ${state}). ` +
              "Stop the owning process or check its startup diagnostics. Automatic recovery requires a positively dead PID; never delete a live relay's lock.",
          );
        }
        unlinkSync(path);
        // A plain-wx starter can win this gap; never delete its replacement.
        try {
          create();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            throw new SynloqError(
              "ALREADY_RUNNING",
              `another synloq serve won the recovered lock (${path}); waiting for its relay startup`,
            );
          }
          throw error;
        }
        recovered = pid;
      });
    }
  } catch (error) {
    if (isPermissionError(error)) throw permissionDenied("acquiring the serve lock", path, error);
    throw error;
  }
  if (recovered !== undefined) {
    try {
      options.onDiagnostic?.(`recovered stale serve lock (pid ${recovered})`);
    } catch {
      /* diagnostics cannot strand ownership */
    }
  }
  let released = false;
  return {
    path,
    release: async () => {
      if (released) return;
      locked(path, () => {
        if (ownerText(path) === record) unlinkSync(path);
      });
      released = true;
    },
  };
}
