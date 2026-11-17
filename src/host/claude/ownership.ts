import { open, realpath, unlink } from "node:fs/promises";
import { basename } from "node:path";
import { requireNudgeIds } from "../../relay/nudge-identifiers.js";

/** Both nudgers and cooperating manual launchers must hold this lock until child exit.
 * Never steal a lock on PID/age heuristics. Raw Claude starts cannot be excluded. */
export async function acquireClaudeOwnership(
  transcript: string,
  sessionId: string,
  owner: "nudger" | "manual",
) {
  requireNudgeIds(sessionId);
  const canonical = await realpath(transcript);
  if (basename(canonical).toLowerCase() !== `${sessionId}.jsonl`.toLowerCase())
    throw new Error("session mismatch");
  const path = `${canonical}.synloq-owner.lock`;
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify({ version: 1, owner, pid: process.pid, sessionId }));
  } finally {
    await handle.close();
  }
  let released = false;
  return {
    path,
    transcript: canonical,
    async release() {
      if (released) return;
      try {
        await unlink(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      released = true;
    },
  };
}
