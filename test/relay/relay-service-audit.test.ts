import { describe, expect, it } from "vitest";
import type { Identity } from "../../src/config/credentials.js";
import type { Participant } from "../../src/domain/message.js";
import {
  NullSecurityAuditLog,
  type SecurityAuditLog,
  type SecurityEvent,
} from "../../src/relay/audit-log.js";
import { ProtectionPolicy } from "../../src/relay/protection.js";
import { RelayService } from "../../src/relay/relay-service.js";
import { SQLiteMessageStore } from "../../src/storage/message-store.js";
import { SessionStore } from "../../src/storage/session-store.js";

const participants: Participant[] = [
  { project: "synloq", agentId: "cto", title: "CTO", role: "coordination" },
  { project: "synloq", agentId: "arch", title: "Architect", role: "review" },
];

class SpyAuditLog implements SecurityAuditLog {
  readonly events: SecurityEvent[] = [];
  record(event: SecurityEvent): void {
    this.events.push(event);
  }
}

function makeRelay(audit: SecurityAuditLog = new NullSecurityAuditLog()) {
  const messages = new SQLiteMessageStore(":memory:");
  const sessions = new SessionStore(":memory:");
  const relay = new RelayService(
    participants,
    messages,
    sessions,
    new ProtectionPolicy(messages),
    undefined,
    undefined,
    audit,
  );
  return { relay, messages, sessions };
}

const cto: Identity = { project: "synloq", agentId: "cto", operator: false };
const arch: Identity = { project: "synloq", agentId: "arch", operator: false };

describe("RelayService audit", () => {
  it("records a deny event when inbox belongs to another role", async () => {
    const audit = new SpyAuditLog();
    const { relay } = makeRelay(audit);
    await expect(
      relay.inbox(cto, { project: "synloq", agentId: "arch", limit: 10 }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({
      project: "synloq",
      agentId: "cto",
      action: "inbox",
      decision: "deny",
      reasonCode: "UNAUTHORIZED",
    });
  });

  it("records a deny event for unknown recipient on send", async () => {
    const audit = new SpyAuditLog();
    const { relay } = makeRelay(audit);
    await expect(
      relay.send(cto, {
        to: "ghost",
        text: "ping",
        expectsReply: false,
        idempotencyKey: "cto-audit-1",
      }),
    ).rejects.toMatchObject({ code: "UNKNOWN_RECIPIENT" });
    expect(audit.events.map((e) => e.reasonCode)).toEqual(["UNKNOWN_RECIPIENT"]);
  });

  it("does not record successful operations", async () => {
    const audit = new SpyAuditLog();
    const { relay } = makeRelay(audit);
    await relay.send(cto, {
      to: "arch",
      text: "ok",
      expectsReply: false,
      idempotencyKey: "cto-audit-2",
    });
    expect(audit.events).toHaveLength(0);
  });

  it("records a deny event when acknowledging a message addressed to another role", async () => {
    const audit = new SpyAuditLog();
    const { relay } = makeRelay(audit);
    const message = await relay.send(cto, {
      to: "arch",
      text: "for arch only",
      expectsReply: false,
      idempotencyKey: "cto-audit-3",
    });
    await expect(relay.acknowledge(cto, message.id)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({ action: "acknowledge", reasonCode: "UNAUTHORIZED" });
  });

  it("records a reply-path denial exactly once with action reply", async () => {
    const audit = new SpyAuditLog();
    const { relay } = makeRelay(audit);
    await expect(
      relay.reply(cto, {
        inReplyTo: "00000000-0000-0000-0000-000000000000",
        text: "no such parent",
        expectsReply: false,
        idempotencyKey: "cto-audit-4",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({ action: "reply", reasonCode: "NOT_FOUND" });
  });

  it("defaults to NullSecurityAuditLog when no audit is injected", async () => {
    const { relay } = makeRelay();
    await expect(
      relay.inbox(cto, { project: "synloq", agentId: "arch", limit: 10 }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
