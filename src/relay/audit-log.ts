import { appendFileSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isPermissionError, permissionDenied } from "../domain/errors.js";

export type AuditedAction =
  | "send"
  | "reply"
  | "inbox"
  | "acknowledge"
  | "getMessage"
  | "pause"
  | "resume"
  | "authenticate"
  | "directory"
  | "claim"
  | "issue"
  | "rotate"
  | "revoke"
  | "replaceSession"
  | "registerSession"
  | "heartbeat"
  | "close"
  | "authorizeDelivery"
  | "deliveryReceipt"
  | "deliveryFailure"
  | "doctor"
  | "longPoll"
  | "webhook";

/** Denials must never copy request-controlled strings from an error message. */
export function denialDetail(action: AuditedAction): string {
  return `${action} request denied`;
}

export interface SecurityEvent {
  at: string;
  project: string;
  agentId: string;
  action: AuditedAction;
  decision: "deny" | "degraded" | "accept";
  reasonCode: string;
  detail: string;
  /** Issue #114: aggregate rows collapse a denial flood into one line. */
  kind?: "aggregate";
  /** Aggregates only: ISO start of the collapsed window. */
  windowStart?: string;
  /** Aggregates only: events collapsed into this row (including the first). */
  count?: number;
}

export interface SecurityAuditLog {
  record(event: SecurityEvent): void;
}

export class NullSecurityAuditLog implements SecurityAuditLog {
  record(_event: SecurityEvent): void {
    // intentional no-op: default when no audit sink is configured
  }
}

interface AggregateWindow {
  first: SecurityEvent;
  count: number;
  windowStartMs: number;
}

export interface FileSecurityAuditLogOptions {
  /** Clock override for tests. */
  now?: () => number;
  /** Aggregation window for denial floods; defaults to one minute. */
  windowMs?: number;
}

/**
 * Issue #114: a denial flood (~150 B per row) must not grow the log without
 * bound. Deny events aggregate per (action, agentId): the first denial is
 * written in full (forensic evidence), repeats within the window are counted,
 * and the window closes with one aggregate row carrying the count. Accept and
 * degraded decisions are never aggregated — they are rare and forensically
 * valuable. A relay crash loses the unflushed window count (the first event
 * is already durable) — accepted, documented in the PR.
 */
export class FileSecurityAuditLog implements SecurityAuditLog {
  private readonly now: () => number;
  private readonly windowMs: number;
  private readonly windows = new Map<string, AggregateWindow>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly path: string,
    options: FileSecurityAuditLogOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.windowMs = options.windowMs ?? 60_000;
  }

  record(event: SecurityEvent): void {
    if (event.decision !== "deny") {
      this.append(event);
      return;
    }
    const key = `${event.action}:${event.agentId}`;
    const now = this.now();
    const window = this.windows.get(key);
    if (window && now - window.windowStartMs < this.windowMs) {
      window.count += 1;
      return;
    }
    if (window) this.flushWindow(key, window);
    this.windows.set(key, { first: event, count: 1, windowStartMs: now });
    this.append(event);
    this.armTimer();
  }

  /** Flushes every open window; safe to call at shutdown. */
  flush(): void {
    for (const [key, window] of [...this.windows]) this.flushWindow(key, window);
  }

  private flushWindow(key: string, window: AggregateWindow): void {
    this.windows.delete(key);
    this.append({
      ...window.first,
      at: new Date(this.now()).toISOString(),
      kind: "aggregate",
      windowStart: new Date(window.windowStartMs).toISOString(),
      count: window.count,
    });
    if (this.windows.size === 0 && this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private armTimer(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, this.windowMs);
    this.timer.unref?.();
  }

  private append(event: SecurityEvent): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, `${JSON.stringify(event)}\n`, "utf8");
    } catch (error) {
      if (isPermissionError(error)) {
        throw permissionDenied("appending to the security audit log", this.path, error);
      }
      throw error;
    }
  }
}

/** The conventional audit log location for a project (issue #3). */
export function auditLogPath(home: string, projectKey: string): string {
  return join(home, "data", `${projectKey}-audit.jsonl`);
}

/**
 * Reads the last `limit` events of an audit log for diagnostics (issue #3,
 * doctor readout). Offline-safe: a missing/unreadable file yields an empty
 * list; malformed lines are skipped rather than failing the report.
 */
export async function readAuditTail(path: string, limit: number): Promise<SecurityEvent[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const events: SecurityEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as SecurityEvent);
    } catch {
      // skip malformed lines: diagnostics must not fail on a torn write
    }
  }
  return events.slice(-limit);
}

/** Read beyond the display tail: unrelated traffic must not hide directory health. */
export async function readDirectoryHealth(
  path: string,
  project: string,
): Promise<{ state: "ok" | "degraded"; since?: string; reason?: string }> {
  const events = await readAuditTail(path, Number.MAX_SAFE_INTEGER);
  const latest = events
    .reverse()
    .find(
      (event) =>
        event?.project === project &&
        event.action === "directory" &&
        (event.decision === "degraded" || event.decision === "accept"),
    );
  return latest?.decision === "degraded"
    ? { state: "degraded", since: latest.at, reason: `${latest.reasonCode}: ${latest.detail}` }
    : { state: "ok" };
}

export interface OpenCodeRegistrationStatus {
  state: "registered" | "blocked";
  at: string;
  reasonCode: string;
}

/** Last MCP registration outcome, not a claim that the host is currently reachable. */
export async function readOpenCodeRegistrations(
  path: string,
  project: string,
): Promise<Map<string, OpenCodeRegistrationStatus>> {
  const statuses = new Map<string, OpenCodeRegistrationStatus>();
  for (const event of await readAuditTail(path, Number.MAX_SAFE_INTEGER)) {
    if (
      event?.project !== project ||
      event.action !== "registerSession" ||
      typeof event.detail !== "string" ||
      !event.detail.includes("surface 'opencode-mcp'") ||
      (event.decision !== "accept" && event.decision !== "deny")
    )
      continue;
    statuses.set(event.agentId, {
      state: event.decision === "accept" ? "registered" : "blocked",
      at: event.at,
      reasonCode: event.reasonCode,
    });
  }
  return statuses;
}
