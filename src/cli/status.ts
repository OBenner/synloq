import type { Clock } from "../adapters/types.js";
import type { Participant } from "../domain/message.js";
import type { AdapterSession, SessionState } from "../domain/session.js";
import type { SQLiteMessageStore } from "../storage/message-store.js";
import type { SessionStore } from "../storage/session-store.js";
import { createDoctorReport, type DoctorReportOptions, type SynloqHomeProbe } from "./doctor.js";
import type { WatchdogFinding } from "../diagnostics/watchdog.js";

const DEFAULT_UNANSWERED_THRESHOLD_MS = 30 * 60_000;

export interface AgingCounter {
  count: number;
  oldestAt?: string;
}

export interface StatusParticipant {
  agentId: string;
  state: SessionState;
  queued: number;
  oldestStoredAt?: string;
  awaitingAck: AgingCounter;
  unansweredAcked: AgingCounter;
  lastHeartbeatAt?: string;
  waitReason: string;
}

export interface StatusReport {
  project: string;
  generatedAt: string;
  storage: { ok: boolean; path: string; error?: string };
  home?: SynloqHomeProbe;
  watchdog: WatchdogFinding[];
  participants: StatusParticipant[];
}

export interface StatusReportOptions extends DoctorReportOptions {
  unansweredThresholdMs?: number;
}

function formatAge(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function ageOf(now: number, iso: string | undefined): string | undefined {
  if (iso === undefined) return undefined;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return undefined;
  return formatAge(now - at);
}

function waitReason(
  participant: Participant,
  session: AdapterSession | undefined,
  state: SessionState,
  inactive: string,
  queued: number,
  oldestStoredAt: string | undefined,
  awaitingAck: AgingCounter,
  now: number,
): string {
  if (inactive.startsWith("delivery-paused")) return inactive;
  if (!session) return "session-not-registered";
  if (queued > 0) {
    const oldest = ageOf(now, oldestStoredAt);
    const suffix = oldest === undefined ? "" : ` (oldest ${oldest})`;
    if (state === "busy") {
      return `${queued} stored — ${participant.agentId} chat is busy${suffix}`;
    }
    if (inactive === "ready") {
      return `${queued} stored — idle, next delivery imminent${suffix}`;
    }
    if (state === "unknown") {
      const heartbeat = ageOf(now, session.lastHeartbeatAt);
      return `${queued} stored — session state unknown/stale${heartbeat === undefined ? "" : ` (last heartbeat ${heartbeat} ago)`}`;
    }
    return `${queued} stored — session is ${state}${suffix}`;
  }
  if (awaitingAck.count > 0) {
    const oldest = ageOf(now, awaitingAck.oldestAt);
    return `delivered, awaiting ack${oldest === undefined ? "" : ` (${oldest})`}`;
  }
  if (inactive === "ready") return "ready";
  return inactive;
}

export function createStatusReport(options: StatusReportOptions): StatusReport {
  const clock: Clock = options.clock ?? { now: () => Date.now() };
  const now = clock.now();
  const doctor = createDoctorReport(options);
  const thresholdMs = Math.max(0, options.unansweredThresholdMs ?? DEFAULT_UNANSWERED_THRESHOLD_MS);
  const olderThanIso = new Date(now - thresholdMs).toISOString();
  const registered = options.sessions?.list(options.project) ?? [];

  const participants = options.participants.map((participant) => {
    const session = registered.find((candidate) => candidate.agentId === participant.agentId);
    const doctorEntry = doctor.participants.find(
      (candidate) => candidate.agentId === participant.agentId,
    );
    const state = doctorEntry?.state ?? "unknown";
    const inactive = doctorEntry?.inactiveReason ?? "session-not-registered";
    const queued = doctorEntry?.pendingCount ?? 0;
    const oldestStoredAt = options.messages?.oldestStoredAt(options.project, participant.agentId);
    const awaitingAck = options.messages?.awaitingAck(options.project, participant.agentId) ?? {
      count: 0,
    };
    const unansweredAcked = options.messages?.unansweredAcked(
      options.project,
      participant.agentId,
      olderThanIso,
    ) ?? { count: 0 };
    let reason = waitReason(
      participant,
      session,
      state,
      inactive,
      queued,
      oldestStoredAt,
      awaitingAck,
      now,
    );
    if (unansweredAcked.count > 0) {
      const oldest = ageOf(now, unansweredAcked.oldestAt);
      reason += `; ${unansweredAcked.count} acked without reply${oldest === undefined ? "" : ` (oldest ${oldest})`}`;
    }
    const finding = doctor.watchdog.find((entry) => entry.agentId === participant.agentId);
    if (finding) {
      reason += `; WATCHDOG ${finding.kind}: ${finding.detail}`;
    }
    const entry: StatusParticipant = {
      agentId: participant.agentId,
      state,
      queued,
      awaitingAck,
      unansweredAcked,
      waitReason: reason,
      ...(oldestStoredAt === undefined ? {} : { oldestStoredAt }),
      ...(session ? { lastHeartbeatAt: session.lastHeartbeatAt } : {}),
    };
    return entry;
  });

  return {
    project: options.project,
    generatedAt: new Date(now).toISOString(),
    storage: doctor.storage,
    ...(doctor.home ? { home: doctor.home } : {}),
    watchdog: doctor.watchdog,
    participants,
  };
}

export function formatStatusReport(report: StatusReport): string {
  const storage = report.storage.ok
    ? `ok (${report.storage.path})`
    : `unavailable (${report.storage.error ?? "unknown error"})`;
  const lines = [
    `project: ${report.project}   relay db: ${storage}`,
    ...(report.home
      ? [
          report.home.writable
            ? `synloq home: ok, writable (${report.home.path})`
            : `synloq home: NOT writable (${report.home.path}) — ${report.home.error ?? "unknown error"}`,
        ]
      : []),
    `generated: ${report.generatedAt}`,
    "",
  ];
  const header = ["ROLE", "STATE", "QUEUED", "WAIT"];
  const rows = report.participants.map((participant) => [
    participant.agentId,
    participant.state,
    String(participant.queued),
    participant.waitReason,
  ]);
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column]!.length)),
  );
  const render = (row: string[]) =>
    row
      .map((cell, column) => cell.padEnd(widths[column]!))
      .join("  ")
      .trimEnd();
  lines.push(render(header));
  for (const row of rows) lines.push(render(row));
  return lines.join("\n");
}
