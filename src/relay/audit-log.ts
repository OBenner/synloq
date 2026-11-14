import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
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
  | "directory";

export interface SecurityEvent {
  at: string;
  project: string;
  agentId: string;
  action: AuditedAction;
  decision: "deny" | "degraded";
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
