import { inactiveReason, type Clock } from "../adapters/types.js";
import type { Participant } from "../domain/message.js";
import type { AdapterCapabilities, AdapterSession, SessionState } from "../domain/session.js";
import type { SQLiteMessageStore } from "../storage/message-store.js";
import type { SessionStore } from "../storage/session-store.js";

export interface DoctorReport {
  storage: { ok: boolean; path: string; error?: string };
  participants: Array<{
    agentId: string;
    sessionId?: string;
    state: SessionState;
    adapterConnected: boolean;
    protocolVersion?: number;
    capabilities?: AdapterCapabilities;
    lastHeartbeatAt?: string;
    pendingCount: number;
    pendingBytes: number;
    inactiveReason: string;
  }>;
}

export interface DoctorReportOptions {
  project: string;
  participants: Participant[];
  databasePath: string;
  messages?: SQLiteMessageStore;
  sessions?: SessionStore;
  clock?: Clock;
  storageError?: string;
}

function hasUnexpiredLease(session: AdapterSession | undefined, now: number): boolean {
  if (!session) return false;
  const leaseExpiresAt = Date.parse(session.leaseExpiresAt);
  return Number.isFinite(leaseExpiresAt) && leaseExpiresAt > now;
}

function pausedReason(
  messages: SQLiteMessageStore | undefined,
  project: string,
  agentId: string,
): string | undefined {
  if (!messages) return undefined;
  if (messages.isPaused(project, "project", "")) return "delivery-paused:project";
  if (messages.isPaused(project, "participant", agentId)) {
    return "delivery-paused:participant";
  }
  const pending = messages.nextPending(project, agentId);
  if (pending && messages.isPaused(project, "thread", pending.threadId)) {
    return "delivery-paused:thread";
  }
  return undefined;
}

export function createDoctorReport(options: DoctorReportOptions): DoctorReport {
  const registered = options.sessions?.list(options.project) ?? [];
  const now = (options.clock ?? { now: () => Date.now() }).now();
  const storage = {
    ok: options.storageError === undefined,
    path: options.databasePath,
    ...(options.storageError === undefined ? {} : { error: options.storageError }),
  };

  return {
    storage,
    participants: options.participants.map((participant) => {
      const session = registered.find((candidate) => candidate.agentId === participant.agentId);
      const state =
        options.sessions?.effectiveState(options.project, participant.agentId) ?? "unknown";
      const usage = options.messages?.pendingUsage(options.project, participant.agentId) ?? {
        count: 0,
        bytes: 0,
      };
      return {
        agentId: participant.agentId,
        ...(session ? { sessionId: session.sessionId } : {}),
        state,
        adapterConnected: storage.ok && hasUnexpiredLease(session, now),
        ...(session
          ? {
              protocolVersion: session.protocolVersion,
              capabilities: session.capabilities,
              lastHeartbeatAt: session.lastHeartbeatAt,
            }
          : {}),
        pendingCount: usage.count,
        pendingBytes: usage.bytes,
        inactiveReason:
          pausedReason(options.messages, options.project, participant.agentId) ??
          inactiveReason(session, state),
      };
    }),
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  return JSON.stringify(report, null, 2);
}
