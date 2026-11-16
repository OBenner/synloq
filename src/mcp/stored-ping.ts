import type { Clock } from "../adapters/types.js";
import { formatDiagnostic } from "../diagnostics.js";
import { evaluateWatchdog } from "../diagnostics/watchdog.js";
import type { Participant } from "../domain/message.js";
import { translate, type Language } from "../i18n/index.js";
import { SQLiteMessageStore } from "../storage/message-store.js";
import { SessionStore } from "../storage/session-store.js";

/**
 * Stored-ping watcher (issue #45, ADR-0005 mixin transport): when this role
 * has messages sitting `stored` past the watchdog threshold while its chat is
 * live and idle, push a lightweight, content-free ping into the chat through
 * the host adapter ("N incoming, oldest <age> — run synloq_inbox"). The ping
 * is a wake-up nudge, not delivery: message text never leaves the relay.
 *
 * Placement mirrors the delivery watchdog: channel-side, per role, driven by
 * the same pure evaluation over the relay stores. A busy chat is mid-turn and
 * is never pinged; a dead session is silent; a paused queue is an explained
 * wait. Throttle: one ping per stored-backlog epoch (keyed on the oldest
 * stored message) plus a minimum repeat interval for an aging backlog the
 * role keeps ignoring.
 *
 * Like every diagnostic surface, a failing check or push must never take the
 * channel down — all errors degrade to a stderr line.
 */
export const DEFAULT_STORED_PING_REPEAT_MS = 30 * 60_000;

export interface StoredPingWatcherOptions {
  project: string;
  agentId: string;
  participants: Participant[];
  databasePath: string;
  diagnostics: { write(chunk: string): unknown };
  /** Push the ping text into the role's chat; resolves true only when sent. */
  push: (text: string) => Promise<boolean>;
  clock?: Clock | undefined;
  language?: Language | undefined;
  thresholdMs?: number | undefined;
  /** Minimum delay before re-pinging an unchanged backlog. */
  repeatMs?: number | undefined;
}

export interface StoredPingWatcher {
  check(): Promise<void>;
}

export function createStoredPingWatcher(options: StoredPingWatcherOptions): StoredPingWatcher {
  const clock = options.clock ?? { now: () => Date.now() };
  const repeatMs = Math.max(0, options.repeatMs ?? DEFAULT_STORED_PING_REPEAT_MS);
  let lastPing: { oldestStoredAt: string; at: number } | undefined;
  let inFlight = false;

  return {
    async check(): Promise<void> {
      if (inFlight) return;
      inFlight = true;
      let messages: SQLiteMessageStore | undefined;
      let sessions: SessionStore | undefined;
      try {
        messages = new SQLiteMessageStore(options.databasePath, undefined, { readOnly: true });
        sessions = new SessionStore(options.databasePath, options.clock, { readOnly: true });
        // Reuse the watchdog predicate: "stored-without-delivery" is exactly
        // "live idle chat + stale stored backlog, not paused" — the only
        // constellation where a nudge helps. busy-stall stays silent (#45).
        const finding = evaluateWatchdog({
          project: options.project,
          participants: options.participants,
          messages,
          sessions,
          clock: options.clock,
          ...(options.thresholdMs === undefined ? {} : { thresholdMs: options.thresholdMs }),
        }).find(
          (entry) => entry.agentId === options.agentId && entry.kind === "stored-without-delivery",
        );
        if (!finding) return;
        const now = clock.now();
        if (
          lastPing &&
          lastPing.oldestStoredAt === finding.oldestStoredAt &&
          now - lastPing.at < repeatMs
        ) {
          return;
        }
        const stored = messages.countStored(options.project, options.agentId);
        const text = translate(options.language ?? "en", "storedPing.text", {
          count: stored,
          age: Math.floor(finding.ageMs / 60_000),
        });
        const sent = await options.push(text);
        if (!sent) {
          options.diagnostics.write(
            `${formatDiagnostic("Synloq stored-ping: chat not pushable right now; backlog stays visible in synloq status")}\n`,
          );
          return;
        }
        lastPing = { oldestStoredAt: finding.oldestStoredAt, at: now };
        options.diagnostics.write(
          `${formatDiagnostic(`Synloq stored-ping: nudged the chat about ${stored} stored message(s)`)}\n`,
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        options.diagnostics.write(
          `${formatDiagnostic(`Synloq stored-ping check failed: ${detail}`)}\n`,
        );
      } finally {
        inFlight = false;
        sessions?.close();
        messages?.close();
      }
    },
  };
}
