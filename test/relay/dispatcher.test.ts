import { afterEach, describe, expect, it, vi } from "vitest";
import type { Clock, DeliveryAdapter, DeliveryReceipt } from "../../src/adapters/types.js";
import { SynloqError } from "../../src/domain/errors.js";
import type { Message } from "../../src/domain/message.js";
import type { AdapterCapabilities, SessionState } from "../../src/domain/session.js";
import { Dispatcher } from "../../src/relay/dispatcher.js";
import { SQLiteMessageStore, type PauseScope } from "../../src/storage/message-store.js";
import { SessionStore } from "../../src/storage/session-store.js";

const PROJECT = "verdicta";
const AGENT = "arch";
const SESSION = "session-arch";
const KEY = `${PROJECT}/${AGENT}`;

class MutableClock implements Clock {
  private current = Date.parse("2026-11-09T00:00:00.000Z");

  now(): number {
    return this.current;
  }

  advance(milliseconds: number): void {
    this.current += milliseconds;
  }
}

class TestAdapter implements DeliveryAdapter {
  readonly capabilities: AdapterCapabilities;
  readonly submissions: Message[] = [];
  handler: ((message: Message) => Promise<DeliveryReceipt>) | undefined;

  constructor(capabilities: Partial<AdapterCapabilities> = {}) {
    this.capabilities = {
      activeDelivery: true,
      stateReporting: true,
      clientIdempotency: true,
      ...capabilities,
    };
  }

  async state(_sessionId: string): Promise<SessionState> {
    return "idle";
  }

  readonly submit = vi.fn(
    async (_sessionId: string, message: Message): Promise<DeliveryReceipt> => {
      this.submissions.push(message);
      return (
        (await this.handler?.(message)) ?? {
          state: "delivered",
          clientMessageId: message.id,
        }
      );
    },
  );
}

interface Fixture {
  clock: MutableClock;
  store: SQLiteMessageStore;
  sessions: SessionStore;
  adapter: TestAdapter;
  dispatcher: Dispatcher;
}

const fixtures: Fixture[] = [];

function makeFixture(capabilities: Partial<AdapterCapabilities> = {}): Fixture {
  const clock = new MutableClock();
  const store = new SQLiteMessageStore(":memory:");
  const sessions = new SessionStore(":memory:", clock);
  const adapter = new TestAdapter(capabilities);
  const mergedCapabilities: AdapterCapabilities = {
    activeDelivery: true,
    stateReporting: true,
    clientIdempotency: true,
    ...capabilities,
  };
  sessions.register(
    {
      project: PROJECT,
      agentId: AGENT,
      sessionId: SESSION,
      protocolVersion: 1,
      capabilities: mergedCapabilities,
    },
    false,
  );
  const dispatcher = new Dispatcher(store, sessions, new Map([[KEY, adapter]]), clock);
  const fixture = { clock, store, sessions, adapter, dispatcher };
  fixtures.push(fixture);
  return fixture;
}

function createMessage(f: Fixture, id: string, createdAt: string, threadId = "thread-1"): Message {
  return f.store.create(
    {
      project: PROJECT,
      from: "cto",
      to: AGENT,
      text: `Payload for ${id}`,
      expectsReply: false,
      idempotencyKey: id,
    },
    id,
    createdAt,
    threadId,
  ).message;
}

function heartbeat(f: Fixture, state: SessionState = "idle"): void {
  f.sessions.heartbeat(PROJECT, AGENT, SESSION, state);
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.sessions.close();
    fixture.store.close();
  }
});

describe("Dispatcher", () => {
  it.each([
    ["project", ""],
    ["participant", AGENT],
    ["thread", "thread-paused"],
  ] as const)("honors a %s pause and resumes the same FIFO entry", async (scope, scopeId) => {
    const f = makeFixture();
    const message = createMessage(
      f,
      `message-${scope}`,
      "2026-11-09T00:00:00.000Z",
      "thread-paused",
    );
    f.store.pause(PROJECT, scope, scopeId, new Date(f.clock.now()).toISOString());

    await f.dispatcher.kick(PROJECT, AGENT);

    expect(f.adapter.submit).not.toHaveBeenCalled();
    expect(f.store.getMessage(message.id)?.deliveryState).toBe("stored");

    f.store.resume(PROJECT, scope as PauseScope, scopeId);
    await f.dispatcher.kick(PROJECT, AGENT);

    expect(f.adapter.submit).toHaveBeenCalledTimes(1);
    expect(f.store.getMessage(message.id)?.deliveryState).toBe("delivered");
  });

  it("shares one drain across concurrent kicks without duplicate submissions", async () => {
    const f = makeFixture();
    const first = createMessage(f, "message-first", "2026-11-09T00:00:00.000Z");
    const second = createMessage(f, "message-second", "2026-11-09T00:00:01.000Z");
    let releaseFirst!: (receipt: DeliveryReceipt) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const blocked = new Promise<DeliveryReceipt>((resolve) => {
      releaseFirst = resolve;
    });
    f.adapter.handler = (message) => {
      if (message.id === first.id) {
        markStarted();
        return blocked;
      }
      return Promise.resolve({ state: "delivered", clientMessageId: message.id });
    };

    const firstKick = f.dispatcher.kick(PROJECT, AGENT);
    const secondKick = f.dispatcher.kick(PROJECT, AGENT);
    expect(secondKick).toBe(firstKick);
    await started;
    expect(f.adapter.submissions.map((message) => message.id)).toEqual([first.id]);

    releaseFirst({ state: "delivered", clientMessageId: first.id });
    await Promise.all([firstKick, secondKick]);

    expect(f.adapter.submissions.map((message) => message.id)).toEqual([first.id, second.id]);
    expect(f.store.getMessage(first.id)?.deliveryState).toBe("delivered");
    expect(f.store.getMessage(second.id)?.deliveryState).toBe("delivered");
  });

  it("stops the drain on a submitted receipt until delivery is recorded", async () => {
    const f = makeFixture();
    const first = createMessage(f, "message-submitted", "2026-11-09T00:00:00.000Z");
    const second = createMessage(f, "message-later", "2026-11-09T00:00:01.000Z");
    f.adapter.handler = (message) =>
      Promise.resolve({
        state: message.id === first.id ? "submitted" : "delivered",
        clientMessageId: message.id,
      });

    await f.dispatcher.kick(PROJECT, AGENT);

    expect(f.adapter.submissions.map((message) => message.id)).toEqual([first.id]);
    expect(f.store.getMessage(first.id)?.deliveryState).toBe("submitted");
    expect(f.store.getMessage(second.id)?.deliveryState).toBe("stored");

    f.store.setDeliveryState(first.id, "delivered");
    await f.dispatcher.kick(PROJECT, AGENT);

    expect(f.adapter.submissions.map((message) => message.id)).toEqual([first.id, second.id]);
    expect(f.store.getMessage(second.id)?.deliveryState).toBe("delivered");
  });

  it("uses bounded exponential backoff without inspecting later FIFO entries", async () => {
    const f = makeFixture();
    const first = createMessage(f, "message-backoff", "2026-11-09T00:00:00.000Z");
    const second = createMessage(f, "message-waiting", "2026-11-09T00:00:01.000Z");
    f.adapter.handler = () => Promise.reject(new Error("pre-transmission failure"));
    const delays = [200, 400, 800, 1_600, 3_200, 6_400, 12_800, 25_600, 30_000, 30_000];

    for (const [index, delay] of delays.entries()) {
      await f.dispatcher.runOnce(PROJECT, AGENT);
      expect(f.adapter.submit).toHaveBeenCalledTimes(index + 1);
      expect(f.store.getMessage(first.id)?.deliveryState).toBe("stored");
      expect(f.store.getMessage(second.id)?.deliveryState).toBe("stored");
      expect(f.adapter.submissions.every((message) => message.id === first.id)).toBe(true);

      await f.dispatcher.kick(PROJECT, AGENT);
      expect(f.adapter.submit).toHaveBeenCalledTimes(index + 1);
      f.clock.advance(delay - 1);
      heartbeat(f);
      await f.dispatcher.runOnce(PROJECT, AGENT);
      expect(f.adapter.submit).toHaveBeenCalledTimes(index + 1);
      f.clock.advance(1);
    }
  });

  it("resets backoff after a successful delivery", async () => {
    const f = makeFixture();
    const first = createMessage(f, "message-recovers", "2026-11-09T00:00:00.000Z");
    const second = createMessage(f, "message-next-failure", "2026-11-09T00:00:01.000Z");
    const failures = new Set([first.id, second.id]);
    const failed = new Set<string>();
    f.adapter.handler = (message) => {
      if (failures.has(message.id) && !failed.has(message.id)) {
        failed.add(message.id);
        return Promise.reject(new Error("transient failure"));
      }
      return Promise.resolve({ state: "delivered", clientMessageId: message.id });
    };

    await f.dispatcher.runOnce(PROJECT, AGENT);
    f.clock.advance(200);
    heartbeat(f);
    await f.dispatcher.runOnce(PROJECT, AGENT);
    expect(f.store.getMessage(first.id)?.deliveryState).toBe("delivered");

    await f.dispatcher.runOnce(PROJECT, AGENT);
    expect(f.store.getMessage(second.id)?.deliveryState).toBe("stored");
    f.clock.advance(199);
    heartbeat(f);
    await f.dispatcher.runOnce(PROJECT, AGENT);
    expect(f.adapter.submissions.filter((message) => message.id === second.id)).toHaveLength(1);
    f.clock.advance(1);
    await f.dispatcher.runOnce(PROJECT, AGENT);
    expect(f.store.getMessage(second.id)?.deliveryState).toBe("delivered");
  });

  it("quarantines uncertain delivery without client idempotency across kicks, heartbeats, and reaping", async () => {
    const f = makeFixture({ clientIdempotency: false });
    const uncertain = createMessage(f, "message-uncertain", "2026-11-09T00:00:00.000Z");
    const later = createMessage(f, "message-quarantined", "2026-11-09T00:00:01.000Z");
    f.adapter.handler = () =>
      Promise.reject(new SynloqError("DELIVERY_UNCERTAIN", "submission outcome is unknown"));

    await f.dispatcher.runOnce(PROJECT, AGENT);

    expect(f.adapter.submit).toHaveBeenCalledTimes(1);
    expect(f.store.getMessage(uncertain.id)?.deliveryState).toBe("submitted");
    expect(f.store.getMessage(later.id)?.deliveryState).toBe("stored");
    expect(f.store.isPaused(PROJECT, "participant", AGENT)).toBe(true);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      heartbeat(f);
      await f.dispatcher.kick(PROJECT, AGENT);
      f.clock.advance(15_001);
      f.sessions.reapExpired(f.store);
      await f.dispatcher.kick(PROJECT, AGENT);
    }

    expect(f.adapter.submit).toHaveBeenCalledTimes(1);
    expect(f.adapter.submissions[0]?.id).toBe(uncertain.id);
    expect(f.store.getMessage(uncertain.id)?.deliveryState).toBe("submitted");
    expect(f.store.getMessage(later.id)?.deliveryState).toBe("stored");
    expect(f.store.isPaused(PROJECT, "participant", AGENT)).toBe(true);
  });

  it("retries uncertain delivery with the same ID when the client is idempotent", async () => {
    const f = makeFixture({ clientIdempotency: true });
    const message = createMessage(f, "message-idempotent", "2026-11-09T00:00:00.000Z");
    let attempts = 0;
    f.adapter.handler = (candidate) => {
      attempts += 1;
      if (attempts === 1) {
        return Promise.reject(new SynloqError("DELIVERY_UNCERTAIN", "retry safely"));
      }
      return Promise.resolve({ state: "delivered", clientMessageId: candidate.id });
    };

    await f.dispatcher.runOnce(PROJECT, AGENT);
    expect(f.store.getMessage(message.id)?.deliveryState).toBe("stored");
    expect(f.store.isPaused(PROJECT, "participant", AGENT)).toBe(false);

    f.clock.advance(199);
    await f.dispatcher.kick(PROJECT, AGENT);
    expect(f.adapter.submit).toHaveBeenCalledTimes(1);
    f.clock.advance(1);
    await f.dispatcher.kick(PROJECT, AGENT);

    expect(f.adapter.submit).toHaveBeenCalledTimes(2);
    expect(f.adapter.submissions.map((candidate) => candidate.id)).toEqual([
      message.id,
      message.id,
    ]);
    expect(f.store.getMessage(message.id)?.deliveryState).toBe("delivered");
  });
});
