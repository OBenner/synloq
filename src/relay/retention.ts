import { formatDiagnostic } from "../diagnostics.js";
import { SynloqError } from "../domain/errors.js";
import type { SQLiteMessageStore } from "../storage/message-store.js";

export const RETENTION_INTERVAL_MS = 60_000;

/** One bounded transaction now and per minute; no asynchronous work survives stop(). */
export function startRetentionSweep(
  store: SQLiteMessageStore,
  project: string,
  days: number,
  diagnostic: (text: string) => void = (text) => process.stderr.write(`${text}\n`),
): () => void {
  const sweep = () => {
    try {
      store.sweepRetention(project, days);
    } catch (error) {
      // Do not print SQL parameters, body hashes or message text in diagnostics.
      const code = error instanceof SynloqError ? error.code : "STORAGE_FAILURE";
      try {
        diagnostic(
          formatDiagnostic(`Synloq retention sweep failed: ${code}; retrying next interval`),
        );
      } catch {
        // A closed stderr must not terminate the live relay.
      }
    }
  };
  sweep();
  const timer = setInterval(sweep, RETENTION_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
