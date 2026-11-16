import { expect, it } from "vitest";
import { SQLiteMessageStore } from "../../src/storage/message-store.js";
import { SessionStore } from "../../src/storage/session-store.js";
import { RelayService } from "../../src/relay/relay-service.js";
import { ProtectionPolicy } from "../../src/relay/protection.js";

it("replays an accepted reply after parent/body purge, but refuses new references and changed content", async () => {
  let now = Date.parse("2026-11-01T00:00:00Z");
  const clock = { now: () => now };
  const messages = new SQLiteMessageStore(":memory:", clock);
  const sessions = new SessionStore(":memory:", clock);
  const roles = ["dev", "staff"].map((agentId) => ({
    project: "test",
    agentId,
    title: agentId,
    role: agentId,
  }));
  const relay = new RelayService(
    roles,
    messages,
    sessions,
    new ProtectionPolicy(messages, undefined, undefined, clock),
    undefined,
    clock,
  );
  const dev = { project: "test", agentId: "dev", operator: false };
  const staff = { project: "test", agentId: "staff", operator: false };
  try {
    const parent = await relay.send(dev, {
      to: "staff",
      text: "TASK private",
      expectsReply: true,
      idempotencyKey: "parent",
    });
    const request = {
      inReplyTo: parent.id,
      text: "RESULT private",
      expectsReply: false,
      idempotencyKey: "reply",
    };
    const reply = await relay.reply(staff, request);
    await relay.acknowledge(staff, parent.id);
    const acked = await relay.acknowledge(dev, reply.id);
    now += 2 * 86_400_000;
    expect(messages.sweepRetention("test", 1).messagesPurged).toBe(2);
    await expect(relay.reply(staff, request)).resolves.toEqual(acked);
    await expect(relay.send(staff, { ...request, to: "dev" })).resolves.toEqual(acked);
    await expect(relay.reply(staff, { ...request, text: "changed" })).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
    await expect(
      relay.reply(staff, { ...request, inReplyTo: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(
      relay.reply(staff, { ...request, idempotencyKey: "new-reply" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(relay.acknowledge(staff, parent.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(relay.getMessage(dev, parent.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(messages.listInbox("test", "dev", undefined, 50).messages).toEqual([]);
    sessions.register(
      {
        project: "test",
        agentId: "staff",
        sessionId: "owner",
        protocolVersion: 1,
        capabilities: { activeDelivery: false, stateReporting: false, clientIdempotency: false },
      },
      false,
    );
    await expect(relay.reply(staff, request)).rejects.toMatchObject({ code: "NOT_WRITER" });
  } finally {
    messages.close();
    sessions.close();
  }
});
