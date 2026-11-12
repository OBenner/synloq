import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type AuditedAction =
  "send" | "reply" | "inbox" | "acknowledge" | "getMessage" | "pause" | "resume" | "authenticate";

export interface SecurityEvent {
  at: string;
  project: string;
  agentId: string;
  action: AuditedAction;
  decision: "deny";
  reasonCode: string;
  detail: string;
}

export interface SecurityAuditLog {
  record(event: SecurityEvent): void;
}

export class NullSecurityAuditLog implements SecurityAuditLog {
  record(): void {
    // intentional no-op: default when no audit sink is configured
  }
}

export class FileSecurityAuditLog implements SecurityAuditLog {
  constructor(private readonly path: string) {}

  record(event: SecurityEvent): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(event)}\n`, "utf8");
  }
}
