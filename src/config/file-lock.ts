import { mkdir, open, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isPermissionError, permissionDenied, SynloqError } from "../domain/errors.js";

/** Cooperative cross-process lock. Never steal a lock on age/PID heuristics. */
export async function withFileLock<T>(
  path: string,
  action: () => Promise<T>,
  timeoutMs = 10_000,
): Promise<T> {
  const lockPath = `${path}.lock`;
  const deadline = performance.now() + timeoutMs;
  try {
    await mkdir(dirname(path), { recursive: true });
    let handle;
    for (;;) {
      try {
        handle = await open(lockPath, "wx", 0o600);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (performance.now() >= deadline) {
          throw new SynloqError(
            "STORAGE_FAILURE",
            `Timed out waiting for credential lock '${lockPath}'. ` +
              "Retry after the current writer finishes. If a writer crashed, stop all project " +
              "credential writers before removing this lock; never remove a live writer's lock.",
          );
        }
        await delay(25 + Math.floor(Math.random() * 25));
      }
    }
    try {
      await handle.writeFile(
        `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
      );
      await handle.close();
      return await action();
    } finally {
      // close() is idempotent, including after a failed metadata write.
      await handle.close();
      await unlink(lockPath);
    }
  } catch (error) {
    if (isPermissionError(error)) throw permissionDenied("locking credentials", path, error);
    throw error;
  }
}
