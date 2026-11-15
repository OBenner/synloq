import { inactiveReason, type Clock } from "../adapters/types.js";
import { evaluateWatchdog, type WatchdogFinding } from "../diagnostics/watchdog.js";
import type { Participant } from "../domain/message.js";
import type { AdapterCapabilities, AdapterSession, SessionState } from "../domain/session.js";
import type { PluginFreshness } from "../host/kimi-work/installed-plugin.js";
import type { SecurityEvent } from "../relay/audit-log.js";
import type { SQLiteMessageStore } from "../storage/message-store.js";
import type { SessionStore } from "../storage/session-store.js";
import type { ChannelConfigHealthReport } from "./repair.js";
import type { HostName } from "../config/hosts.js";

export interface PlacementHealth {
  host: HostName;
  state: "bound" | "unclaimed" | "manual" | "missing" | "configured";
  ok: boolean;
  issue?: string;
}

export interface SynloqHomeProbe {
  path: string;
  writable: boolean;
  error?: string;
}

export interface CredentialHealth {
  tokenPath: string;
  status: "ok" | "missing" | "stale";
}

/**
 * Issue #32 (W6): per-participant checks for roles living on an OpenCode
 * host. `session` is "unknown" unless doctor ran with --check-host and the
 * host answered; `opencodeConfig` reflects the project opencode.json entry
 * ("unreadable" when the file exists but does not parse).
 */
export interface OpenCodeHostCheck {
  sessionId: string;
  session: "alive" | "dead" | "unknown";
  opencodeConfig: "present" | "missing" | "unreadable";
  note?: string;
}

export interface DoctorReport {
  storage: { ok: boolean; path: string; error?: string };
  home?: SynloqHomeProbe;
  watchdog: WatchdogFinding[];
  plugin?: PluginFreshness;
  /** Issue #3 (M4-min): tail of the security audit log (path + last events). */
  audit?: { path: string; entries: SecurityEvent[] };
  repair?: {
    actions: Array<{ agentId: string; token: "reused" | "reissued"; config: string }>;
  };
  participants: Array<{
    agentId: string;
    host?: HostName;
    placement?: PlacementHealth;
    sessionId?: string;
    state: SessionState;
    adapterConnected: boolean;
    credential?: CredentialHealth;
    config?: ChannelConfigHealthReport;
    hostCheck?: OpenCodeHostCheck;
    protocolVersion?: number;
    capabilities?: AdapterCapabilities;
    lastHeartbeatAt?: string;
    pendingCount: number;
    pendingBytes: number;
    inactiveReason: string;
  }>;
}

export interface DoctorReportOptions {
  placements?: Map<string, PlacementHealth>;
  project: string;
  participants: Participant[];
  databasePath: string;
  home?: SynloqHomeProbe;
  credentials?: Map<string, CredentialHealth>;
  configs?: Map<string, ChannelConfigHealthReport>;
  hostChecks?: Map<string, OpenCodeHostCheck>;
  repair?: DoctorReport["repair"];
  messages?: SQLiteMessageStore;
  sessions?: SessionStore;
  clock?: Clock;
  storageError?: string;
  watchdogThresholdMs?: number;
  plugin?: PluginFreshness;
  audit?: DoctorReport["audit"];
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
  const watchdog = evaluateWatchdog({
    project: options.project,
    participants: options.participants,
    messages: options.messages,
    sessions: options.sessions,
    clock: options.clock,
    ...(options.watchdogThresholdMs === undefined
      ? {}
      : { thresholdMs: options.watchdogThresholdMs }),
  });

  return {
    storage,
    watchdog,
    ...(options.home ? { home: options.home } : {}),
    ...(options.plugin ? { plugin: options.plugin } : {}),
    ...(options.audit ? { audit: options.audit } : {}),
    ...(options.repair ? { repair: options.repair } : {}),
    participants: options.participants.map((participant) => {
      const session = registered.find((candidate) => candidate.agentId === participant.agentId);
      const state =
        options.sessions?.effectiveState(options.project, participant.agentId) ?? "unknown";
      const usage = options.messages?.pendingUsage(options.project, participant.agentId) ?? {
        count: 0,
        bytes: 0,
      };
      const credential = options.credentials?.get(participant.agentId);
      const config = options.configs?.get(participant.agentId);
      const hostCheck = options.hostChecks?.get(participant.agentId);
      return {
        agentId: participant.agentId,
        ...(options.placements?.get(participant.agentId)
          ? {
              host: options.placements.get(participant.agentId)!.host,
              placement: options.placements.get(participant.agentId)!,
            }
          : {}),
        ...(session ? { sessionId: session.sessionId } : {}),
        state,
        adapterConnected: storage.ok && hasUnexpiredLease(session, now),
        ...(credential ? { credential } : {}),
        ...(config ? { config } : {}),
        ...(hostCheck ? { hostCheck } : {}),
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
