import { afterEach, describe, expect, it } from "vitest";
import type { Identity } from "../../src/config/credentials.js";
import type { Participant } from "../../src/domain/message.js";
import { PROTOCOL_VERSION } from "../../src/domain/session.js";
import type { SecurityAuditLog, SecurityEvent } from "../../src/relay/audit-log.js";
import { ProtectionPolicy } from "../../src/relay/protection.js";
import { RelayService } from "../../src/relay/relay-service.js";
import { SQLiteMessageStore } from "../../src/storage/message-store.js";
import { SessionStore } from "../../src/storage/session-store.js";

const participants: Participant[] = [
  { project: "synloq", agentId: "cto", title: "CTO", role: "coordination" },
  { project: "synloq", agentId: "arch", title: "Architect", role: "review" },
  { project: "other", agentId: "cto", title: "CTO", role: "coordination" },
  { project: "other", agentId: "arch", title: "Architect", role: "review" },
];

class SpyAuditLog implements SecurityAuditLog {
  readonly events: SecurityEvent[] = [];
  record(event: SecurityEvent): void {
    this.events.push(event);
  }
}

const cto: Identity = { project: "synloq", agentId: "cto", operator: false };
const arch: Identity = { project: "synloq", agentId: "arch", operator: false };
const operator: Identity = { project: "synloq", agentId: "operator", operator: true };

const capabilities = {
  activeDelivery: true,
  stateReporting: true,
  clientIdempotency: true,
};

const stores: Array<{ close(): void }> = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function makeRelay() {
  const messages = new SQLiteMessageStore(":memory:");
  const sessions = new SessionStore(":memory:");
  stores.push(messages, sessions);
  const audit = new SpyAuditLog();
  const relay = new RelayService(
    participants,
    messages,
    sessions,
    new ProtectionPolicy(messages),
    undefined,
    undefined,
    audit,
  );
  return { relay, messages, sessions, audit };
}

function registerWriter(sessions: SessionStore, sessionId: string, replace = false) {
  return sessions.register(
    {
      project: "synloq",
      agentId: "cto",
      sessionId,
      protocolVersion: PROTOCOL_VERSION,
      capabilities,
    },
    replace,
  );
}

function sendDraft(sessionId?: string) {
  return {
    to: "arch" as const,
    text: "status update",
    expectsReply: false,
    idempotencyKey: `key-${crypto.randomUUID()}`,
    ...(sessionId === undefined ? {} : { sessionId }),
  };
}

function toCto(sessionId?: string) {
  return { ...sendDraft(sessionId), to: "cto" as const };
}

describe("RelayService single-writer enforcement (#46)", () => {
  it("lets the writer session send, reply, and ack", async () => {
    const { relay, sessions } = makeRelay();
    registerWriter(sessions, "ses-cto-main");

    await expect(relay.send(cto, sendDraft("ses-cto-main"))).resolves.toMatchObject({
      from: "cto",
      deliveryState: "stored",
    });
    const incoming = await relay.send(arch, toCto());
    await expect(
      relay.reply(cto, {
        inReplyTo: incoming.id,
        text: "acknowledged, on it",
        expectsReply: false,
        idempotencyKey: `key-${crypto.randomUUID()}`,
        sessionId: "ses-cto-main",
      }),
    ).resolves.toMatchObject({ from: "cto", inReplyTo: incoming.id });
    await expect(relay.acknowledge(cto, incoming.id, "ses-cto-main")).resolves.toMatchObject({
      deliveryState: "acked",
    });
  });

  it("rejects send/reply/ack from a second chat of the same role", async () => {
    const { relay, sessions, audit } = makeRelay();
    registerWriter(sessions, "ses-cto-main");
    const incoming = await relay.send(arch, toCto());

    await expect(relay.send(cto, sendDraft("ses-cto-mirror"))).rejects.toMatchObject({
      code: "NOT_WRITER",
    });
    await expect(
      relay.reply(cto, {
        inReplyTo: incoming.id,
        text: "mirror trying to answer",
        expectsReply: false,
        idempotencyKey: `key-${crypto.randomUUID()}`,
        sessionId: "ses-cto-mirror",
      }),
    ).rejects.toMatchObject({ code: "NOT_WRITER" });
    await expect(relay.acknowledge(cto, incoming.id, "ses-cto-mirror")).rejects.toMatchObject({
      code: "NOT_WRITER",
    });

    const denied = audit.events.filter(
      (event) => event.decision === "deny" && event.reasonCode === "NOT_WRITER",
    );
    expect(denied.map((event) => event.action).sort()).toEqual(["acknowledge", "reply", "send"]);
    expect(denied[0]?.detail).toBe("send request denied");
    expect(JSON.stringify(denied)).not.toContain("ses-cto-mirror");
  });

  it("rejects token-only writes once a writer session exists", async () => {
    const { relay, sessions } = makeRelay();
    registerWriter(sessions, "ses-cto-main");

    await expect(relay.send(cto, sendDraft())).rejects.toMatchObject({ code: "NOT_WRITER" });
  });

  it("keeps token-only writes for a role without any session (hook-style channels)", async () => {
    const { relay } = makeRelay();

    await expect(relay.send(cto, sendDraft())).resolves.toMatchObject({ from: "cto" });
  });

  it("never gates the operator", async () => {
    const { relay, sessions } = makeRelay();
    registerWriter(sessions, "ses-cto-main");

    await expect(relay.send(operator, sendDraft())).resolves.toMatchObject({
      from: "operator",
    });
  });

  it("flips ownership via replace-session: the old chat stops writing, the new one writes", async () => {
    const { relay, sessions } = makeRelay();
    registerWriter(sessions, "ses-cto-main");
    registerWriter(sessions, "ses-cto-new", true);

    await expect(relay.send(cto, sendDraft("ses-cto-main"))).rejects.toMatchObject({
      code: "NOT_WRITER",
    });
    await expect(relay.send(cto, sendDraft("ses-cto-new"))).resolves.toMatchObject({
      from: "cto",
    });
  });

  it("scopes the writer per project: a session in another project does not gate this one", async () => {
    const { relay, sessions } = makeRelay();
    sessions.register(
      {
        project: "other",
        agentId: "cto",
        sessionId: "ses-other",
        protocolVersion: PROTOCOL_VERSION,
        capabilities,
      },
      false,
    );

    await expect(relay.send(cto, sendDraft())).resolves.toMatchObject({ from: "cto" });
  });
});
