import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { isPermissionError, permissionDenied, SynloqError } from "../domain/errors.js";

/**
 * Advisory lock beside the project database (issue #110): exactly one
 * `synloq serve` may own a project database. Two concurrent serves split
 * silently on in-memory state (rate buckets, long-poll caps) even though
 * SQLite itself stays consistent — a beginner mistake, not an attack.
 *
 * The lock is an exclusive-create file (`wx`) holding the owner PID and
 * start time. Never auto-steal on age/PID heuristics (#15 discipline): a
 * stale lock after a crash is removed by the operator, with the error
 * message saying exactly that.
 */
export interface ServeLock {
  /** Path of the lock file, for diagnostics. */
  path: string;
  /** Idempotent release; missing file (manually removed) is fine. */
  release(): Promise<void>;
}

export async function acquireServeLock(databasePath: string): Promise<ServeLock> {
  const lockPath = `${databasePath}.serve.lock`;
  let handle;
  try {
    await mkdir(dirname(lockPath), { recursive: true });
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      let owner = "unreadable lock file";
      try {
        owner = (await readFile(lockPath, "utf8")).trim();
      } catch {
        // Keep the generic owner text.
      }
      throw new SynloqError(
        "ALREADY_RUNNING",
        `another synloq serve already owns this project database (lock ${lockPath}: ${owner}). ` +
          "Stop that process first. If it crashed and no such PID is running, " +
          "delete the lock file and retry — never delete a live relay's lock.",
      );
    }
    if (isPermissionError(error)) {
      throw permissionDenied("acquiring the serve lock", lockPath, error);
    }
    throw error;
  }
  try {
    await handle.writeFile(
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
    );
  } finally {
    await handle.close();
  }

  let released = false;
  return {
    path: lockPath,
    release: async () => {
      if (released) return;
      released = true;
      try {
        await unlink(lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  };
}
