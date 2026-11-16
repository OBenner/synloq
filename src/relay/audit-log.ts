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
  | "registerSession";

export interface SecurityEvent {
  at: string;
  project: string;
  agentId: string;
  action: AuditedAction;
  decision: "deny" | "degraded" | "accept";
  reasonCode: string;
  detail: string;
}

export interface SecurityAuditLog {
  record(event: SecurityEvent): void;
}

export class NullSecurityAuditLog implements SecurityAuditLog {
  record(_event: SecurityEvent): void {
    // intentional no-op: default when no audit sink is configured
  }
}

export class FileSecurityAuditLog implements SecurityAuditLog {
  constructor(private readonly path: string) {}

  record(event: SecurityEvent): void {
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
