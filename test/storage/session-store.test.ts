import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore } from "../../src/storage/session-store.js";
import { inactiveReason, type Clock } from "../../src/adapters/types.js";
import type { SendMessageInput } from "../../src/domain/message.js";
import { PROTOCOL_VERSION, type SessionRegistration } from "../../src/domain/session.js";
import { SQLiteMessageStore } from "../../src/storage/message-store.js";

class MutableClock implements Clock {
  private current = Date.parse("2026-11-09T00:00:00.000Z");

  now(): number {
    return this.current;
  }

  advance(milliseconds: number): void {
    this.current += milliseconds;
  }
}

function ctoSession(sessionId: string): SessionRegistration {
  return {
    project: "verdicta",
    agentId: "cto",
    sessionId,
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {
      activeDelivery: true,
      stateReporting: true,
      clientIdempotency: true,
    },
  };
}

const clocks: MutableClock[] = [];
const stores: SessionStore[] = [];
const messageStores: SQLiteMessageStore[] = [];
const temporaryDirectories: string[] = [];

function makeStore(path = ":memory:"): {
  store: SessionStore;
  clock: MutableClock;
} {
  const clock = new MutableClock();
  const store = new SessionStore(path, clock);
  clocks.push(clock);
  stores.push(store);
  return { store, clock };
}

function makeMessages(path = ":memory:"): SQLiteMessageStore {
  const store = new SQLiteMessageStore(path);
  messageStores.push(store);
  return store;
}

class InterleavingMessageStore extends SQLiteMessageStore {
  constructor(
    path: string,
    private readonly afterSubmittedSnapshot: () => void,
  ) {
    super(path);
  }

  listSubmitted(project: string, recipient: string) {
    const submitted = super.listSubmitted(project, recipient);
    this.afterSubmittedSnapshot();
    return submitted;
  }
}

function makeSharedReapingStores(afterSubmittedSnapshot: () => void = () => {}): {
  store: SessionStore;
  clock: MutableClock;
  messages: InterleavingMessageStore;
} {
  const directory = mkdtempSync(join(tmpdir(), "synloq-reaping-race-"));
  temporaryDirectories.push(directory);
  const database = join(directory, "synloq.sqlite");
  const { store, clock } = makeStore(database);
  const messages = new InterleavingMessageStore(database, afterSubmittedSnapshot);
  messageStores.push(messages);
  return { store, clock, messages };
}

function createSubmitted(
  store: SQLiteMessageStore,
  id: string,
  recipient = "cto",
  idempotencyKey = id,
): void {
  const input: SendMessageInput = {
    project: "verdicta",
    from: "operator",
    to: recipient,
    text: "Review the lease boundary",
    expectsReply: false,
    idempotencyKey,
  };
  store.create(input, id, "2026-11-09T00:00:00.000Z", crypto.randomUUID());
  store.setDeliveryState(id, "submitted");
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const store of messageStores.splice(0)) store.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SessionStore", () => {
  it("rejects a second visible session for the same role", () => {
    const { store } = makeStore();
    store.register(ctoSession("session-a"), false);

    expect(() => store.register(ctoSession("session-b"), false)).toThrow(
      expect.objectContaining({ code: "DUPLICATE_SESSION" }),
    );
    expect(store.list("verdicta")[0]?.sessionId).toBe("session-a");
  });

  it("rejects reuse of a session ID by another role", () => {
    const { store } = makeStore();
    store.register(ctoSession("session-a"), false);

    expect(() => store.register({ ...ctoSession("session-a"), agentId: "arch" }, false)).toThrow(
      expect.objectContaining({ code: "DUPLICATE_SESSION" }),
    );
    expect(store.list("verdicta").map((session) => session.agentId)).toEqual(["cto"]);
  });

  it("allows same-session reconnect with fresh lease and capabilities before state arrives", () => {
    const { store, clock } = makeStore();
    store.register(ctoSession("session-a"), false);
    store.heartbeat("verdicta", "cto", "session-a", "closed");
    clock.advance(10_000);

    const reconnected = store.register(ctoSession("session-a"), false);

    expect(reconnected).toMatchObject({
      state: "unknown",
      capabilities: ctoSession("session-a").capabilities,
      lastHeartbeatAt: new Date(clock.now()).toISOString(),
      stateObservedAt: new Date(clock.now()).toISOString(),
      leaseExpiresAt: new Date(clock.now() + 15_000).toISOString(),
    });
    expect(store.effectiveState("verdicta", "cto")).toBe("unknown");
    store.heartbeat("verdicta", "cto", "session-a", "idle");
    expect(store.effectiveState("verdicta", "cto")).toBe("idle");
    expect(store.list("verdicta")).toHaveLength(1);
  });

  it("allows a different session only when operator replacement is requested", () => {
    const { store } = makeStore();
    store.register(ctoSession("session-a"), false);
    const replaced = store.register(ctoSession("session-b"), true);

    expect(replaced.sessionId).toBe("session-b");
    expect(store.list("verdicta").map((session) => session.sessionId)).toEqual(["session-b"]);
  });

  it("rejects an incompatible protocol before changing state", () => {
    const { store } = makeStore();

    expect(() => store.register({ ...ctoSession("session-a"), protocolVersion: 2 }, false)).toThrow(
      expect.objectContaining({ code: "INCOMPATIBLE_PROTOCOL" }),
    );
    expect(store.list("verdicta")).toEqual([]);

    store.register(ctoSession("session-a"), false);
    expect(() => store.register({ ...ctoSession("session-b"), protocolVersion: 2 }, true)).toThrow(
      expect.objectContaining({ code: "INCOMPATIBLE_PROTOCOL" }),
    );
    expect(store.list("verdicta")[0]?.sessionId).toBe("session-a");
  });

  it("forces unknown at the exact lease expiry boundary", () => {
    const directory = mkdtempSync(join(tmpdir(), "synloq-lease-boundary-"));
    temporaryDirectories.push(directory);
    const database = join(directory, "synloq.sqlite");
    const { store, clock } = makeStore(database);
    store.register(ctoSession("session-a"), false);
    store.heartbeat("verdicta", "cto", "session-a", "idle");
    clock.advance(14_999);

    // Isolate lease expiry from the independently tested five-second state timeout.
    const inspector = new DatabaseSync(database);
    inspector
      .prepare("UPDATE sessions SET state_observed_at = ? WHERE session_id = ?")
      .run(new Date(clock.now()).toISOString(), "session-a");
    inspector.close();
    expect(store.effectiveState("verdicta", "cto")).toBe("idle");
    clock.advance(1);
    expect(store.effectiveState("verdicta", "cto")).toBe("unknown");
  });

  it("forces unknown only after the five-second state freshness boundary", () => {
    const { store, clock } = makeStore();
    store.register(ctoSession("session-a"), false);
    store.heartbeat("verdicta", "cto", "session-a", "idle");
    clock.advance(5_000);
    expect(store.effectiveState("verdicta", "cto")).toBe("idle");
    clock.advance(1);
    expect(store.effectiveState("verdicta", "cto")).toBe("unknown");
  });

  it("renews both the lease and state observation on every heartbeat", () => {
    const { store, clock } = makeStore();
    const registration = ctoSession("session-a");
    store.register(registration, false);
    clock.advance(4_000);

    const heartbeat = store.heartbeat("verdicta", "cto", "session-a", "busy");
    expect(heartbeat).toMatchObject({
      state: "busy",
      capabilities: registration.capabilities,
      lastHeartbeatAt: new Date(clock.now()).toISOString(),
      stateObservedAt: new Date(clock.now()).toISOString(),
      leaseExpiresAt: new Date(clock.now() + 15_000).toISOString(),
    });
    clock.advance(5_000);
    expect(store.effectiveState("verdicta", "cto")).toBe("busy");
    clock.advance(1);
    expect(store.effectiveState("verdicta", "cto")).toBe("unknown");
  });

  it("returns closed only while the close observation is fresh", () => {
    const { store, clock } = makeStore();
    store.register(ctoSession("session-a"), false);
    clock.advance(1_000);

    const closed = store.close("verdicta", "cto", "session-a");
    expect(closed).toMatchObject({
      state: "closed",
      capabilities: ctoSession("session-a").capabilities,
      stateObservedAt: new Date(clock.now()).toISOString(),
    });
    expect(store.effectiveState("verdicta", "cto")).toBe("closed");
    clock.advance(5_001);
    expect(store.effectiveState("verdicta", "cto")).toBe("unknown");
  });

  it("fails closed when state reporting is unsupported", () => {
    const { store } = makeStore();
    const registration = ctoSession("session-a");
    registration.capabilities.stateReporting = false;
    store.register(registration, false);

    expect(store.effectiveState("verdicta", "cto")).toBe("unknown");
    expect(store.list("verdicta")[0]?.capabilities).toEqual(registration.capabilities);
  });

  it("rejects heartbeat and close from a different session without changing state", () => {
    const { store } = makeStore();
    store.register(ctoSession("session-a"), false);
    store.heartbeat("verdicta", "cto", "session-a", "idle");

    expect(() => store.heartbeat("verdicta", "cto", "session-b", "busy")).toThrow(
      expect.objectContaining({ code: "UNAUTHORIZED" }),
    );
    expect(() => store.close("verdicta", "cto", "session-b")).toThrow(
      expect.objectContaining({ code: "UNAUTHORIZED" }),
    );
    expect(store.list("verdicta")[0]?.state).toBe("idle");
  });

  it("rejects a heartbeat carrying a stale generation without changing state", () => {
    const { store } = makeStore();
    const registered = store.register(ctoSession("session-a"), false);
    store.heartbeat("verdicta", "cto", "session-a", "idle", registered.generation);
    store.register(ctoSession("session-a"), false);

    expect(() =>
      store.heartbeat("verdicta", "cto", "session-a", "busy", registered.generation),
    ).toThrow(expect.objectContaining({ code: "UNAUTHORIZED" }));
    // Re-registration reset the state; the stale heartbeat must not have changed it.
    expect(store.list("verdicta")[0]?.state).toBe("unknown");
  });

  it("accepts a heartbeat without a generation for rolling-upgrade compatibility", () => {
    const { store } = makeStore();
    store.register(ctoSession("session-a"), false);

    const heartbeat = store.heartbeat("verdicta", "cto", "session-a", "idle");
    expect(heartbeat.state).toBe("idle");
  });

  it("persists sessions in user_version 4 and restores them after reopening", () => {
    const directory = mkdtempSync(join(tmpdir(), "synloq-sessions-"));
    temporaryDirectories.push(directory);
    const database = join(directory, "synloq.sqlite");
    const first = makeStore(database);
    first.store.register(ctoSession("session-a"), false);
    first.store.heartbeat("verdicta", "cto", "session-a", "busy");
    const persisted = first.store.list("verdicta")[0];
    first.store.close();
    stores.splice(stores.indexOf(first.store), 1);

    const reopened = makeStore(database);
    expect(reopened.store.list("verdicta")).toEqual([persisted]);
    const inspector = new DatabaseSync(database);
    const version = inspector.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    inspector.close();
    expect(version.user_version).toBe(4);
  });
});

describe("inactiveReason", () => {
  it("reports missing, incompatible, unsupported, non-idle, and ready states", () => {
    const session = {
      ...ctoSession("session-a"),
      generation: 1,
      state: "idle" as const,
      lastHeartbeatAt: "2026-11-09T00:00:00.000Z",
      stateObservedAt: "2026-11-09T00:00:00.000Z",
      leaseExpiresAt: "2026-11-09T00:00:15.000Z",
    };

    expect(inactiveReason(undefined)).toBe("session-not-registered");
    expect(inactiveReason({ ...session, protocolVersion: 2 })).toBe("incompatible-protocol");
    expect(
      inactiveReason({
        ...session,
        capabilities: { ...session.capabilities, activeDelivery: false },
      }),
    ).toBe("active-delivery-unsupported");
    expect(
      inactiveReason({
        ...session,
        capabilities: { ...session.capabilities, stateReporting: false },
      }),
    ).toBe("state-reporting-unsupported");
    expect(inactiveReason(session, "busy")).toBe("session-busy");
    expect(inactiveReason(session, "closed")).toBe("session-closed");
    expect(inactiveReason(session, "unknown")).toBe("session-unknown");
    expect(inactiveReason(session)).toBe("ready");
  });
});

describe("expired-session reaping", () => {
  it("resets submitted messages only for an expired idempotent adapter", () => {
    const { store, clock, messages } = makeSharedReapingStores();
    store.register(ctoSession("session-a"), false);
    store.register({ ...ctoSession("session-b"), agentId: "arch" }, false);
    createSubmitted(messages, "message-cto");
    createSubmitted(messages, "message-arch", "arch");
    clock.advance(15_000);
    store.heartbeat("verdicta", "arch", "session-b", "idle");

    store.reapExpired(messages);

    expect(messages.getMessage("message-cto")?.deliveryState).toBe("stored");
    expect(messages.getMessage("message-arch")?.deliveryState).toBe("submitted");
    expect(messages.nextPending("verdicta", "cto")?.id).toBe("message-cto");
  });

  it("keeps uncertain submissions blocked without client idempotency", () => {
    const { store, clock, messages } = makeSharedReapingStores();
    const registration = ctoSession("session-a");
    registration.capabilities.clientIdempotency = false;
    store.register(registration, false);
    createSubmitted(messages, "message-uncertain");
    clock.advance(15_001);

    store.reapExpired(messages);

    expect(messages.getMessage("message-uncertain")?.deliveryState).toBe("submitted");
    expect(messages.nextPending("verdicta", "cto")).toBeUndefined();
  });

  it("does not reset a stale snapshot after the lease is renewed", () => {
    const { store, clock, messages } = makeSharedReapingStores(() => {
      store.heartbeat("verdicta", "cto", "session-a", "idle");
    });
    store.register(ctoSession("session-a"), false);
    createSubmitted(messages, "message-renewed");
    clock.advance(15_001);

    store.reapExpired(messages);

    expect(messages.getMessage("message-renewed")?.deliveryState).toBe("submitted");
  });

  it("releases a stale claim at replacement registration, not through reaping", () => {
    let stateAfterReplacement: string | undefined;
    const { store, clock, messages } = makeSharedReapingStores(() => {
      const replacement = ctoSession("session-b");
      replacement.capabilities.clientIdempotency = false;
      store.register(replacement, true);
      stateAfterReplacement = messages.getMessage("message-replaced")?.deliveryState;
    });
    store.register(ctoSession("session-a"), false);
    createSubmitted(messages, "message-replaced");
    clock.advance(15_001);

    store.reapExpired(messages);

    // The replacement registration is the reconcile point and releases the
    // outstanding claim itself (issue #28); reaping must not act on the stale
    // idempotent snapshot afterwards.
    expect(stateAfterReplacement).toBe("stored");
    expect(messages.getMessage("message-replaced")?.deliveryState).toBe("stored");
  });

  it("skips delivered progress and continues reaping later submitted messages", () => {
    const { store, clock, messages } = makeSharedReapingStores(() => {
      messages.setDeliveryState("message-progressed", "delivered");
    });
    store.register(ctoSession("session-a"), false);
    createSubmitted(messages, "message-progressed");
    createSubmitted(messages, "message-still-submitted");
    clock.advance(15_001);

    expect(() => store.reapExpired(messages)).not.toThrow();

    expect(messages.getMessage("message-progressed")?.deliveryState).toBe("delivered");
    expect(messages.getMessage("message-still-submitted")?.deliveryState).toBe("stored");
  });

  it("persists per-message quarantine across reopen and idempotent reaping", () => {
    const directory = mkdtempSync(join(tmpdir(), "synloq-durable-quarantine-"));
    temporaryDirectories.push(directory);
    const database = join(directory, "synloq.sqlite");
    const first = makeStore(database);
    const firstMessages = makeMessages(database);
    first.store.register(ctoSession("session-a"), false);
    createSubmitted(firstMessages, "message-durable-quarantine");

    expect(
      firstMessages.quarantineDelivery(
        "message-durable-quarantine",
        "verdicta",
        "cto",
        "2026-11-09T00:00:00.000Z",
      ).deliveryState,
    ).toBe("submitted");
    const inspector = new DatabaseSync(database);
    const quarantine = inspector
      .prepare(
        "SELECT message_id, project, recipient FROM delivery_quarantine WHERE message_id = ?",
      )
      .get("message-durable-quarantine");
    inspector.close();
    expect(quarantine).toEqual({
      message_id: "message-durable-quarantine",
      project: "verdicta",
      recipient: "cto",
    });
    first.store.close();
    firstMessages.close();

    const reopened = makeStore(database);
    const reopenedMessages = makeMessages(database);
    reopened.clock.advance(15_001);
    reopened.store.reapExpired(reopenedMessages);

    expect(reopenedMessages.getMessage("message-durable-quarantine")?.deliveryState).toBe(
      "submitted",
    );
    expect(reopenedMessages.nextPending("verdicta", "cto")).toBeUndefined();
  });

  it("resets only submitted rows through the explicit retry boundary", () => {
    const messages = makeMessages();
    createSubmitted(messages, "message-submitted");

    expect(messages.resetSubmittedForRetry("message-submitted").deliveryState).toBe("stored");
    expect(() => messages.resetSubmittedForRetry("message-submitted")).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(() => messages.resetSubmittedForRetry("missing")).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
  });
});
