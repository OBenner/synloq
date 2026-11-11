import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Clock, DeliveryAdapter, DeliveryReceipt } from "../../src/adapters/types.js";
import { SynloqError } from "../../src/domain/errors.js";
import type { Message } from "../../src/domain/message.js";
import type { AdapterCapabilities, SessionState } from "../../src/domain/session.js";
import { Dispatcher } from "../../src/relay/dispatcher.js";
import {
  SQLiteMessageStore,
  type ClaimedDelivery,
  type PauseScope,
} from "../../src/storage/message-store.js";
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

class EmptyCheckMessageStore extends SQLiteMessageStore {
  onEmpty: (() => void) | undefined;

  constructor(path: string, clock: Clock) {
    super(path, clock);
  }

  claimNextDelivery(
    project: string,
    recipient: string,
    binding: { sessionId: string; generation: number },
  ): ClaimedDelivery | null {
    const claimed = super.claimNextDelivery(project, recipient, binding);
    if (!claimed) this.onEmpty?.();
    return claimed;
  }
}

interface Fixture {
  clock: MutableClock;
  store: SQLiteMessageStore;
  sessions: SessionStore;
  adapter: TestAdapter;
  dispatcher: Dispatcher;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const fixtures: Fixture[] = [];
const temporaryDirectories: string[] = [];

function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), "synloq-dispatcher-"));
  temporaryDirectories.push(directory);
  return join(directory, "synloq.sqlite");
}

function makeFixture(
  capabilities: Partial<AdapterCapabilities> = {},
  sessionCapabilities: Partial<AdapterCapabilities> = capabilities,
  databasePath = temporaryDatabase(),
  suppliedStore?: SQLiteMessageStore,
): Fixture {
  const clock = new MutableClock();
  const store = suppliedStore ?? new SQLiteMessageStore(databasePath, clock);
  const sessions = new SessionStore(databasePath, clock);
  const adapter = new TestAdapter(capabilities);
  const mergedCapabilities: AdapterCapabilities = {
    activeDelivery: true,
    stateReporting: true,
    clientIdempotency: true,
    ...sessionCapabilities,
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
  sessions.heartbeat(PROJECT, AGENT, SESSION, "idle");
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
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
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
      return Promise.resolve({
        state: "delivered",
        clientMessageId: message.id,
      });
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
      return Promise.resolve({
        state: "delivered",
        clientMessageId: message.id,
      });
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
      return Promise.resolve({
        state: "delivered",
        clientMessageId: candidate.id,
      });
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

  it("excludes overlapping runOnce calls from submitting the same FIFO row", async () => {
    const f = makeFixture();
    const first = createMessage(f, "message-once-first", "2026-11-09T00:00:00.000Z");
    const second = createMessage(f, "message-once-second", "2026-11-09T00:00:01.000Z");
    const started = deferred<void>();
    const blocked = deferred<DeliveryReceipt>();
    f.adapter.handler = (message) => {
      if (message.id === first.id) {
        started.resolve(undefined);
        return blocked.promise;
      }
      return Promise.resolve({
        state: "delivered",
        clientMessageId: message.id,
      });
    };

    const firstAttempt = f.dispatcher.runOnce(PROJECT, AGENT);
    const overlappingAttempt = f.dispatcher.runOnce(PROJECT, AGENT);
    await started.promise;
    blocked.resolve({ state: "delivered", clientMessageId: first.id });
    const results = await Promise.allSettled([firstAttempt, overlappingAttempt]);

    expect(overlappingAttempt).toBe(firstAttempt);
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(f.adapter.submissions.map((message) => message.id)).toEqual([first.id]);
    expect(f.store.getMessage(first.id)?.deliveryState).toBe("delivered");
    expect(f.store.getMessage(second.id)?.deliveryState).toBe("stored");
  });

  it("shares exclusion between runOnce and kick while preserving drain semantics", async () => {
    const f = makeFixture();
    const first = createMessage(f, "message-mixed-first", "2026-11-09T00:00:00.000Z");
    const second = createMessage(f, "message-mixed-second", "2026-11-09T00:00:01.000Z");
    const started = deferred<void>();
    const blocked = deferred<DeliveryReceipt>();
    f.adapter.handler = (message) => {
      if (message.id === first.id) {
        started.resolve(undefined);
        return blocked.promise;
      }
      return Promise.resolve({
        state: "delivered",
        clientMessageId: message.id,
      });
    };

    const attempt = f.dispatcher.runOnce(PROJECT, AGENT);
    const overlappingDrain = f.dispatcher.kick(PROJECT, AGENT);
    await started.promise;
    blocked.resolve({ state: "delivered", clientMessageId: first.id });
    const results = await Promise.allSettled([attempt, overlappingDrain]);

    expect(overlappingDrain).toBe(attempt);
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(f.adapter.submissions.map((message) => message.id)).toEqual([first.id, second.id]);
    expect(f.store.getMessage(first.id)?.deliveryState).toBe("delivered");
    expect(f.store.getMessage(second.id)?.deliveryState).toBe("delivered");
  });

  it("rechecks work when a kick overlaps the terminal empty queue check", async () => {
    const database = temporaryDatabase();
    const store = new EmptyCheckMessageStore(database, new MutableClock());
    const f = makeFixture({}, {}, database, store);
    const first = createMessage(f, "message-terminal-first", "2026-11-09T00:00:00.000Z");
    const secondId = "message-terminal-second";
    let overlappingDrain: Promise<void> | undefined;
    store.onEmpty = () => {
      store.onEmpty = undefined;
      createMessage(f, secondId, "2026-11-09T00:00:01.000Z");
      overlappingDrain = f.dispatcher.kick(PROJECT, AGENT);
    };

    const initialDrain = f.dispatcher.kick(PROJECT, AGENT);
    await initialDrain;
    if (!overlappingDrain) throw new Error("terminal empty check was not observed");
    await overlappingDrain;

    expect(overlappingDrain).toBe(initialDrain);
    expect(f.adapter.submissions.map((message) => message.id)).toEqual([first.id, secondId]);
    expect(f.store.getMessage(first.id)?.deliveryState).toBe("delivered");
    expect(f.store.getMessage(secondId)?.deliveryState).toBe("delivered");
  });

  it("keeps asymmetric uncertain quarantine through reaping and participant resume", async () => {
    const directory = mkdtempSync(join(tmpdir(), "synloq-asymmetric-quarantine-"));
    temporaryDirectories.push(directory);
    const database = join(directory, "synloq.sqlite");
    const f = makeFixture({ clientIdempotency: false }, { clientIdempotency: true }, database);
    const uncertain = createMessage(f, "message-asymmetric", "2026-11-09T00:00:00.000Z");
    const later = createMessage(f, "message-after-resume", "2026-11-09T00:00:01.000Z");
    f.adapter.handler = () =>
      Promise.reject(new SynloqError("DELIVERY_UNCERTAIN", "submission outcome is unknown"));

    await f.dispatcher.runOnce(PROJECT, AGENT);
    expect(f.store.getMessage(uncertain.id)?.deliveryState).toBe("submitted");
    expect(f.store.isPaused(PROJECT, "participant", AGENT)).toBe(true);

    f.clock.advance(15_001);
    f.sessions.reapExpired(f.store);
    expect(f.store.getMessage(uncertain.id)?.deliveryState).toBe("submitted");

    f.store.resume(PROJECT, "participant", AGENT);
    heartbeat(f);
    await f.dispatcher.kick(PROJECT, AGENT);

    expect(f.adapter.submit).toHaveBeenCalledTimes(1);
    expect(f.store.getMessage(uncertain.id)?.deliveryState).toBe("submitted");
    expect(f.store.getMessage(later.id)?.deliveryState).toBe("stored");

    f.clock.advance(15_001);
    f.sessions.reapExpired(f.store);
    expect(f.store.getMessage(uncertain.id)?.deliveryState).toBe("submitted");

    f.sessions.register(
      {
        project: PROJECT,
        agentId: AGENT,
        sessionId: SESSION,
        protocolVersion: 1,
        capabilities: {
          activeDelivery: true,
          stateReporting: true,
          clientIdempotency: true,
        },
      },
      false,
    );
    await f.dispatcher.kick(PROJECT, AGENT);

    expect(f.adapter.submit).toHaveBeenCalledTimes(1);
    expect(f.store.getMessage(uncertain.id)?.deliveryState).toBe("submitted");
    expect(f.store.getMessage(later.id)?.deliveryState).toBe("stored");
  });

  it("reaps ordinary idempotent submissions during an operator pause", async () => {
    const directory = mkdtempSync(join(tmpdir(), "synloq-ordinary-pause-reaping-"));
    temporaryDirectories.push(directory);
    const database = join(directory, "synloq.sqlite");
    const f = makeFixture({}, {}, database);
    const message = createMessage(f, "message-ordinary-paused", "2026-11-09T00:00:00.000Z");
    f.store.setDeliveryState(message.id, "submitted");
    f.store.pause(PROJECT, "participant", AGENT, new Date(f.clock.now()).toISOString());

    f.clock.advance(15_001);
    f.sessions.reapExpired(f.store);

    expect(f.store.getMessage(message.id)?.deliveryState).toBe("stored");

    f.store.resume(PROJECT, "participant", AGENT);
    f.sessions.register(
      {
        project: PROJECT,
        agentId: AGENT,
        sessionId: SESSION,
        protocolVersion: 1,
        capabilities: {
          activeDelivery: true,
          stateReporting: true,
          clientIdempotency: true,
        },
      },
      false,
    );
    heartbeat(f);
    await f.dispatcher.kick(PROJECT, AGENT);

    expect(f.adapter.submit).toHaveBeenCalledTimes(1);
    expect(f.adapter.submissions[0]?.id).toBe(message.id);
    expect(f.store.getMessage(message.id)?.deliveryState).toBe("delivered");
  });

  it("atomically excludes independent dispatchers from the same FIFO row", async () => {
    const f = makeFixture();
    const message = createMessage(f, "message-atomic-claim", "2026-11-09T00:00:00.000Z");
    const started = deferred<void>();
    const blocked = deferred<DeliveryReceipt>();
    f.adapter.handler = () => {
      started.resolve(undefined);
      return blocked.promise;
    };
    const secondAdapter = new TestAdapter();
    const independent = new Dispatcher(
      f.store,
      f.sessions,
      new Map([[KEY, secondAdapter]]),
      f.clock,
    );

    const firstAttempt = f.dispatcher.runOnce(PROJECT, AGENT);
    await started.promise;
    await independent.runOnce(PROJECT, AGENT);

    const secondSubmissionCount = secondAdapter.submit.mock.calls.length;
    const stateBeforeCompletion = f.store.getMessage(message.id)?.deliveryState;
    blocked.resolve({ state: "delivered", clientMessageId: message.id });
    const [firstResult] = await Promise.allSettled([firstAttempt]);

    expect(secondSubmissionCount).toBe(0);
    expect(stateBeforeCompletion).toBe("submitted");
    expect(firstResult.status).toBe("fulfilled");
    expect(f.store.getMessage(message.id)?.deliveryState).toBe("delivered");
  });

  it("rejects a stale adapter completion after same-session reconnect", async () => {
    const f = makeFixture();
    const message = createMessage(f, "message-stale-completion", "2026-11-09T00:00:00.000Z");
    const started = deferred<void>();
    const blocked = deferred<DeliveryReceipt>();
    f.adapter.handler = () => {
      started.resolve(undefined);
      return blocked.promise;
    };

    const attempt = f.dispatcher.runOnce(PROJECT, AGENT);
    await started.promise;
    f.sessions.register(
      {
        project: PROJECT,
        agentId: AGENT,
        sessionId: SESSION,
        protocolVersion: 1,
        capabilities: f.adapter.capabilities,
      },
      false,
    );
    heartbeat(f);
    blocked.resolve({ state: "delivered", clientMessageId: message.id });

    await expect(attempt).resolves.toBeUndefined();
    expect(f.store.getMessage(message.id)?.deliveryState).toBe("stored");
  });
});
