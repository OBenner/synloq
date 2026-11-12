import { describe, expect, it } from "vitest";
import type { Identity } from "../../src/config/credentials.js";
import type { Participant } from "../../src/domain/message.js";
import type { SecurityAuditLog, SecurityEvent } from "../../src/relay/audit-log.js";
import { ProtectionPolicy } from "../../src/relay/protection.js";
import { RelayService } from "../../src/relay/relay-service.js";
import { SQLiteMessageStore } from "../../src/storage/message-store.js";
import { SessionStore } from "../../src/storage/session-store.js";

const participants: Participant[] = [
  { project: "synloq", agentId: "cto", title: "CTO", role: "coordination" },
  { project: "synloq", agentId: "arch", title: "Architect", role: "review" },
  { project: "synloq", agentId: "security", title: "Security", role: "hardening" },
  { project: "synloq", agentId: "dev", title: "Developer", role: "implementation" },
  { project: "other", agentId: "arch", title: "Other Arch", role: "other project" },
];

class SpyAuditLog implements SecurityAuditLog {
  readonly events: SecurityEvent[] = [];
  record(event: SecurityEvent): void {
    this.events.push(event);
  }
}

function makeRelay() {
  const audit = new SpyAuditLog();
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
  return { relay, audit };
}

const as = (id: string, project = "synloq"): Identity => ({
  project,
  agentId: id,
  operator: false,
});

let seq = 0;
const key = (prefix: string) => `${prefix}-conf-${++seq}`;

describe("cross-channel conformance", () => {
  it("inbox of a foreign role is UNAUTHORIZED and audited", async () => {
    const { relay, audit } = makeRelay();
    await expect(
      relay.inbox(as("arch"), { project: "synloq", agentId: "cto", limit: 10 }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(audit.events).toHaveLength(1);
  });

  it("reply to a message addressed to another role is NOT_FOUND and audited", async () => {
    const { relay, audit } = makeRelay();
    const message = await relay.send(as("cto"), {
      to: "arch",
      text: "arch only",
      expectsReply: true,
      idempotencyKey: key("cto"),
    });
    await expect(
      relay.reply(as("security"), {
        inReplyTo: message.id,
        text: "I was not asked",
        expectsReply: false,
        idempotencyKey: key("sec"),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({ action: "reply", agentId: "security" });
  });

  it("acknowledging a message addressed to another role is UNAUTHORIZED and audited", async () => {
    const { relay, audit } = makeRelay();
    const message = await relay.send(as("cto"), {
      to: "dev",
      text: "dev task",
      expectsReply: true,
      idempotencyKey: key("cto"),
    });
    await expect(relay.acknowledge(as("arch"), message.id)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(audit.events.map((e) => e.action)).toEqual(["acknowledge"]);
  });

  it("getMessage between two other roles is UNAUTHORIZED and audited", async () => {
    const { relay, audit } = makeRelay();
    const message = await relay.send(as("cto"), {
      to: "dev",
      text: "private thread",
      expectsReply: false,
      idempotencyKey: key("cto"),
    });
    await expect(relay.getMessage(as("security"), message.id)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(audit.events).toHaveLength(1);
  });

  it("sending to a non-existent role is UNKNOWN_RECIPIENT and audited", async () => {
    const { relay, audit } = makeRelay();
    await expect(
      relay.send(as("cto"), {
        to: "ghost",
        text: "nobody home",
        expectsReply: false,
        idempotencyKey: key("cto"),
      }),
    ).rejects.toMatchObject({ code: "UNKNOWN_RECIPIENT" });
    expect(audit.events).toHaveLength(1);
  });

  it("cross-project: recipient existing only in another project is UNKNOWN_RECIPIENT", async () => {
    const { relay, audit } = makeRelay();
    await expect(
      relay.send(as("arch", "other"), {
        to: "cto",
        text: "wrong project boundary",
        expectsReply: false,
        idempotencyKey: key("arch"),
      }),
    ).rejects.toMatchObject({ code: "UNKNOWN_RECIPIENT" });
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]!.project).toBe("other");
  });

  it("a participant CAN read and ack own inbox end-to-end without audit events", async () => {
    const { relay, audit } = makeRelay();
    const message = await relay.send(as("cto"), {
      to: "dev",
      text: "legit",
      expectsReply: true,
      idempotencyKey: key("cto"),
    });
    const inbox = await relay.inbox(as("dev"), { project: "synloq", agentId: "dev", limit: 10 });
    expect(inbox.messages.map((m) => m.id)).toContain(message.id);
    await expect(relay.acknowledge(as("dev"), message.id)).resolves.toMatchObject({
      deliveryState: "acked",
    });
    expect(audit.events).toHaveLength(0);
  });
});
