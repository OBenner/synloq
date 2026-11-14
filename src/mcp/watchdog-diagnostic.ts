import type { Clock } from "../adapters/types.js";
import { formatDiagnostic } from "../diagnostics.js";
import { evaluateWatchdog, type WatchdogFinding } from "../diagnostics/watchdog.js";
import type { Participant } from "../domain/message.js";
import { SQLiteMessageStore } from "../storage/message-store.js";
import { SessionStore } from "../storage/session-store.js";

/**
 * Channel-side watchdog surface (issue #11): the MCP stdio bridge re-checks
 * its own role against the relay database on a timer and writes a timestamped
 * stderr line when a finding appears. stderr is the only channel a wedged
 * delivery path can still reach, and the Kimi Code log captures it on
 * process exit. Diagnostics must never break the channel, so every failure
 * of the check itself is swallowed.
 */
export interface WatchdogDiagnosticOptions {
  project: string;
  agentId: string;
  participants: Participant[];
  databasePath: string;
  diagnostics: { write(chunk: string): unknown };
  clock?: Clock | undefined;
  thresholdMs?: number | undefined;
}

export interface WatchdogDiagnostic {
  check(): void;
}

export function createWatchdogDiagnostic(options: WatchdogDiagnosticOptions): WatchdogDiagnostic {
  const reported = new Set<string>();
  return {
    check(): void {
      let messages: SQLiteMessageStore | undefined;
      let sessions: SessionStore | undefined;
      try {
        messages = new SQLiteMessageStore(options.databasePath);
        sessions = new SessionStore(options.databasePath, options.clock);
        const findings = evaluateWatchdog({
          project: options.project,
          participants: options.participants,
          messages,
          sessions,
          clock: options.clock,
          ...(options.thresholdMs === undefined ? {} : { thresholdMs: options.thresholdMs }),
        }).filter((finding: WatchdogFinding) => finding.agentId === options.agentId);
        for (const finding of findings) {
          const key = `${finding.kind}:${finding.oldestStoredAt}`;
          if (reported.has(key)) continue;
          reported.add(key);
          options.diagnostics.write(
            `${formatDiagnostic(`Synloq delivery watchdog: ${finding.kind} — ${finding.detail}`)}\n`,
          );
        }
      } catch {
        // A diagnostic must never take the channel down.
      } finally {
        sessions?.close();
        messages?.close();
      }
    },
  };
}
