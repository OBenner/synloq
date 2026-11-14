import type { Clock } from "../adapters/types.js";
import type { Participant } from "../domain/message.js";
import type { SQLiteMessageStore } from "../storage/message-store.js";
import type { SessionStore } from "../storage/session-store.js";

/**
 * Delivery watchdog (issue #11): detects the two stall classes observed in
 * the 2026-11-12 incidents, where heartbeats looked healthy but the visible
 * queue was not moving.
 *
 * - "stored-without-delivery": the oldest stored message is older than the
 *   threshold while the session is idle with a live channel — a claim should
 *   have succeeded, so the delivery path is wedged.
 * - "busy-stall": the chat has reported busy continuously while the oldest
 *   stored message aged past the threshold — a host-side turn stall holds
 *   the queue. Not a Synloq violation, but it must surface instead of
 *   looking like a messaging outage.
 *
 * The evaluator is pure over the relay stores so the same rules drive
 * `synloq doctor`/`synloq status` output and the MCP stderr diagnostic.
 * Findings never contain message text or credentials.
 */
export const DEFAULT_WATCHDOG_THRESHOLD_MS = 15 * 60_000;

export type WatchdogKind = "stored-without-delivery" | "busy-stall";

export interface WatchdogFinding {
  agentId: string;
  kind: WatchdogKind;
  /** Age of the oldest stored message at evaluation time. */
  ageMs: number;
  oldestStoredAt: string;
  detail: string;
}

export interface EvaluateWatchdogOptions {
  project: string;
  participants: Participant[];
  messages?: SQLiteMessageStore | undefined;
  sessions?: SessionStore | undefined;
  clock?: Clock | undefined;
  thresholdMs?: number | undefined;
}

function formatAge(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function isPaused(messages: SQLiteMessageStore, project: string, agentId: string): boolean {
  if (messages.isPaused(project, "project", "")) return true;
  if (messages.isPaused(project, "participant", agentId)) return true;
  const pending = messages.nextPending(project, agentId);
  return pending !== undefined && messages.isPaused(project, "thread", pending.threadId);
}

export function evaluateWatchdog(options: EvaluateWatchdogOptions): WatchdogFinding[] {
  const { messages, sessions } = options;
  if (!messages || !sessions) return [];
  const now = (options.clock ?? { now: () => Date.now() }).now();
  const thresholdMs = Math.max(0, options.thresholdMs ?? DEFAULT_WATCHDOG_THRESHOLD_MS);
  const registered = sessions.list(options.project);
  const findings: WatchdogFinding[] = [];

  for (const participant of options.participants) {
    const oldestStoredAt = messages.oldestStoredAt(options.project, participant.agentId);
    if (oldestStoredAt === undefined) continue;
    const ageMs = now - Date.parse(oldestStoredAt);
    if (!Number.isFinite(ageMs) || ageMs <= thresholdMs) continue;
    // A paused queue is an explained wait, not a stall.
    if (isPaused(messages, options.project, participant.agentId)) continue;
    const session = registered.find((candidate) => candidate.agentId === participant.agentId);
    if (!session) continue; // "session-not-registered" is already surfaced by doctor
    const leaseExpiresAt = Date.parse(session.leaseExpiresAt);
    const adapterConnected = Number.isFinite(leaseExpiresAt) && leaseExpiresAt > now;
    const state = sessions.effectiveState(options.project, participant.agentId);
    const stored = messages.countStored(options.project, participant.agentId);
    if (adapterConnected && state === "idle") {
      findings.push({
        agentId: participant.agentId,
        kind: "stored-without-delivery",
        ageMs,
        oldestStoredAt,
        detail: `${stored} stored, oldest ${formatAge(ageMs)}; session idle with a live channel — claim should succeed (possible delivery wedge)`,
      });
    } else if (state === "busy") {
      findings.push({
        agentId: participant.agentId,
        kind: "busy-stall",
        ageMs,
        oldestStoredAt,
        detail: `${stored} stored held for ${formatAge(ageMs)} behind a continuously busy chat — possible host-side stall`,
      });
    }
  }
  return findings;
}
