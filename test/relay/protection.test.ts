import { afterEach, describe, expect, it } from "vitest";
import type { Identity } from "../../src/config/credentials.js";
import type { Participant, SendMessageInput } from "../../src/domain/message.js";
import { ProtectionPolicy, type ProtectionLimits } from "../../src/relay/protection.js";
import { RelayService, type SendRequest } from "../../src/relay/relay-service.js";
import { SQLiteMessageStore } from "../../src/storage/message-store.js";
import { SessionStore } from "../../src/storage/session-store.js";

const participants: Participant[] = [
  { project: "verdicta", agentId: "cto", title: "CTO", role: "Strategy" },
  { project: "verdicta", agentId: "arch", title: "Architect", role: "Architecture" },
  { project: "verdicta", agentId: "tester", title: "Tester", role: "Verification" },
];

const cto: Identity = { project: "verdicta", agentId: "cto", operator: false };
const arch: Identity = { project: "verdicta", agentId: "arch", operator: false };
const operator: Identity = { project: "verdicta", agentId: "operator", operator: true };
const otherProjectOperator: Identity = {
  project: "another-project",
  agentId: "operator",
  operator: true,
};

const stores: SQLiteMessageStore[] = [];
const sessionStores: SessionStore[] = [];
let now = Date.parse("2026-11-09T00:00:00.000Z");
const clock = { now: () => now };

const testLimits: ProtectionLimits = {
  senderPerMinute: 2,
  recipientPerMinute: 20,
  maxPendingMessages: 1,
  maxPendingBytes: 1024,
  maxThreadMessagesPerWindow: 3,
  threadWindowMs: 120_000,
  maxConcurrentLongPollsPerIdentity: 2,
};

function makeStore(): SQLiteMessageStore {
  const store = new SQLiteMessageStore(":memory:");
  stores.push(store);
  return store;
}

function input(overrides: Partial<SendMessageInput> = {}): SendMessageInput {
  return {
    project: "verdicta",
    from: "cto",
    to: "arch",
    text: "Review the protection boundary",
    expectsReply: true,
    idempotencyKey: crypto.randomUUID(),
    ...overrides,
  };
}

function request(overrides: Partial<SendRequest> = {}): SendRequest {
  const { project: _project, from: _from, ...sendRequest } = input(overrides);
  return sendRequest;
}

function makeRelay(limits: ProtectionLimits) {
  const store = makeStore();
  const sessions = new SessionStore(":memory:");
  sessionStores.push(sessions);
  const protection = new ProtectionPolicy(store, limits, new Map(), clock);
  const relay = new RelayService(participants, store, sessions, protection, undefined, clock);
  return { relay, store, protection };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const store of sessionStores.splice(0)) store.close();
  now = Date.parse("2026-11-09T00:00:00.000Z");
});

describe("ProtectionPolicy", () => {
  it("rejects a burst without creating the excessive message", () => {
    const store = makeStore();
    const protection = new ProtectionPolicy(store, testLimits, new Map(), clock);

    protection.beforeSend(input());
    protection.beforeSend(input());

    expect(() => protection.beforeSend(input())).toThrow(
      expect.objectContaining({ code: "RATE_LIMITED" }),
    );
    expect(store.listInbox("verdicta", "arch", undefined, 50).messages).toHaveLength(0);
  });

  it("refills sender tokens only at the exact 60-second boundary", () => {
    const store = makeStore();
    const protection = new ProtectionPolicy(store, testLimits, new Map(), clock);
    protection.beforeSend(input());
    protection.beforeSend(input());

    now += 59_999;
    expect(() => protection.beforeSend(input())).toThrow(
      expect.objectContaining({ code: "RATE_LIMITED" }),
    );
    now += 1;
    expect(() => protection.beforeSend(input())).not.toThrow();
  });

  it("applies the recipient window across different senders", () => {
    const store = makeStore();
    const protection = new ProtectionPolicy(
      store,
      { ...testLimits, senderPerMinute: 20, recipientPerMinute: 2 },
      new Map(),
      clock,
    );

    protection.beforeSend(input({ from: "cto" }));
    protection.beforeSend(input({ from: "tester" }));

    expect(() => protection.beforeSend(input({ from: "arch" }))).toThrow(
      expect.objectContaining({ code: "RATE_LIMITED" }),
    );
  });

  it("rejects a send when one message is already pending", () => {
    const store = makeStore();
    store.create(input(), crypto.randomUUID(), new Date(now).toISOString(), crypto.randomUUID());
    const protection = new ProtectionPolicy(store, testLimits, new Map(), clock);

    expect(() => protection.beforeSend(input())).toThrow(
      expect.objectContaining({ code: "QUEUE_FULL" }),
    );
    expect(store.listInbox("verdicta", "arch", undefined, 50).messages).toHaveLength(1);
  });

  it("allows the exact pending-byte limit and rejects one byte beyond it", () => {
    const store = makeStore();
    store.create(
      input({ text: "🙂abc" }),
      crypto.randomUUID(),
      new Date(now).toISOString(),
      crypto.randomUUID(),
    );
    const protection = new ProtectionPolicy(
      store,
      { ...testLimits, maxPendingMessages: 10, maxPendingBytes: 8 },
      new Map(),
      clock,
    );

    expect(() => protection.beforeSend(input({ text: "a" }))).not.toThrow();
    expect(() => protection.beforeSend(input({ text: "ab" }))).toThrow(
      expect.objectContaining({ code: "QUEUE_FULL" }),
    );
    expect(store.pendingUsage("verdicta", "arch")).toEqual({ count: 1, bytes: 7 });
  });

  it("counts thread messages at the inclusive window boundary", () => {
    const store = makeStore();
    const protection = new ProtectionPolicy(store, testLimits, new Map(), clock);
    const threadId = crypto.randomUUID();
    const boundary = new Date(now - testLimits.threadWindowMs).toISOString();
    const older = new Date(now - testLimits.threadWindowMs - 1).toISOString();
    store.create(input(), crypto.randomUUID(), boundary, threadId);
    store.create(input(), crypto.randomUUID(), older, threadId);
    store.create(input(), crypto.randomUUID(), new Date(now).toISOString(), crypto.randomUUID());

    expect(store.countThreadSince(threadId, boundary)).toBe(1);
    protection.afterAccept(
      store.create(input(), crypto.randomUUID(), new Date(now).toISOString(), threadId).message,
    );
    expect(store.isPaused("verdicta", "thread", threadId)).toBe(false);
    protection.afterAccept(
      store.create(input(), crypto.randomUUID(), new Date(now).toISOString(), threadId).message,
    );
    expect(store.isPaused("verdicta", "thread", threadId)).toBe(true);
  });

  it("caps concurrent long-poll slots per identity and releases them", () => {
    const store = makeStore();
    const protection = new ProtectionPolicy(store, testLimits, new Map(), clock);

    const first = protection.acquireLongPoll("verdicta", "arch");
    const second = protection.acquireLongPoll("verdicta", "arch");
    expect(() => protection.acquireLongPoll("verdicta", "arch")).toThrow(
      expect.objectContaining({ code: "RATE_LIMITED" }),
    );

    // Other identities and other projects are unaffected.
    expect(() => protection.acquireLongPoll("verdicta", "cto")).not.toThrow();
    expect(() => protection.acquireLongPoll("another-project", "arch")).not.toThrow();

    first();
    expect(() => protection.acquireLongPoll("verdicta", "arch")).not.toThrow();

    // Release is idempotent: a double release must not free an extra slot.
    second();
    second();
    expect(() => protection.acquireLongPoll("verdicta", "arch")).not.toThrow();
  });
});

describe("RelayService protection integration", () => {
  it("does not persist a send rejected by the rate limit", async () => {
    const { relay, store } = makeRelay({ ...testLimits, senderPerMinute: 1 });

    await relay.send(cto, request());
    await expect(relay.send(cto, request())).rejects.toMatchObject({ code: "RATE_LIMITED" });

    expect(store.listInbox("verdicta", "arch", undefined, 50).messages).toHaveLength(1);
  });

  it("does not persist a send rejected by queue backpressure", async () => {
    const { relay, store } = makeRelay(testLimits);

    await relay.send(cto, request());
    await expect(relay.send(cto, request())).rejects.toMatchObject({ code: "QUEUE_FULL" });

    expect(store.listInbox("verdicta", "arch", undefined, 50).messages).toHaveLength(1);
  });

  it("pauses only active delivery for a cyclic thread", async () => {
    const { relay, store } = makeRelay({
      ...testLimits,
      maxPendingMessages: 10,
      maxPendingBytes: 10_000,
    });

    const first = await relay.send(cto, request());
    const second = await relay.reply(arch, {
      inReplyTo: first.id,
      text: "Use one SQLite writer",
      expectsReply: true,
      idempotencyKey: crypto.randomUUID(),
    });
    const third = await relay.reply(cto, {
      inReplyTo: second.id,
      text: "Document the transaction boundary",
      expectsReply: false,
      idempotencyKey: crypto.randomUUID(),
    });

    expect(store.isPaused("verdicta", "thread", first.threadId)).toBe(true);
    expect(store.nextPending("verdicta", "arch")?.threadId).toBe(first.threadId);
    expect(store.getMessage(third.id)?.deliveryState).toBe("stored");

    const acceptedWhilePaused = await relay.reply(arch, {
      inReplyTo: third.id,
      text: "Queued messages remain acceptable",
      expectsReply: false,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(store.getMessage(acceptedWhilePaused.id)?.deliveryState).toBe("stored");
  });

  it("allows only a same-project operator to pause and resume delivery", () => {
    const { relay, store } = makeRelay(testLimits);

    expect(() => relay.pause(cto, "verdicta", "participant", "arch")).toThrow(
      expect.objectContaining({ code: "UNAUTHORIZED" }),
    );
    expect(() => relay.resume(cto, "verdicta", "participant", "arch")).toThrow(
      expect.objectContaining({ code: "UNAUTHORIZED" }),
    );
    expect(() => relay.pause(otherProjectOperator, "verdicta", "participant", "arch")).toThrow(
      expect.objectContaining({ code: "UNAUTHORIZED" }),
    );

    relay.pause(operator, "verdicta", "participant", "arch");
    expect(store.isPaused("verdicta", "participant", "arch")).toBe(true);
    relay.resume(operator, "verdicta", "participant", "arch");
    expect(store.isPaused("verdicta", "participant", "arch")).toBe(false);
  });
});
