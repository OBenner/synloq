import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOpenCodeApi,
  OpenCodeAdapter,
  runOpenCodeAdapter,
  type OpenCodeAdmission,
  type OpenCodeApi,
  type OpenCodeSessionSnapshot,
} from "../../src/adapters/opencode.js";
import { frameMessage } from "../../src/adapters/reference.js";
import type { Clock } from "../../src/adapters/types.js";
import { SynloqError } from "../../src/domain/errors.js";
import type { Message } from "../../src/domain/message.js";
import { PROTOCOL_VERSION, type AdapterCapabilities } from "../../src/domain/session.js";
import { Dispatcher } from "../../src/relay/dispatcher.js";
import { SQLiteMessageStore } from "../../src/storage/message-store.js";
import { SessionStore } from "../../src/storage/session-store.js";
import type { RelayHttpClient } from "../../src/transport/http-client.js";
import { MutableClock, contractDatabase } from "./contract.js";

const SESSION_ID = "ses_cto";
const config = { project: "verdicta", agentId: "cto", sessionId: SESSION_ID };
const message: Message = {
  id: "69d2065f-46a4-4b2f-9482-f9a64f349e26",
  project: "verdicta",
  from: "arch",
  to: "cto",
  text: "Review the queued admission protocol",
  expectsReply: false,
  idempotencyKey: "opencode-message",
  threadId: "thread-opencode",
  createdAt: "2026-11-09T00:00:00.000Z",
  deliveryState: "stored",
};

class FakeEventStream implements AsyncIterable<unknown> {
  private readonly events: unknown[] = [];
  private readonly waiters: Array<(result: IteratorResult<unknown>) => void> = [];
  private ended = false;

  get isEnded(): boolean {
    return this.ended;
  }

  push(event: unknown): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.events.push(event);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ value: undefined, done: true });
    }
  }

  next(): Promise<IteratorResult<unknown>> {
    const event = this.events.shift();
    if (event !== undefined) return Promise.resolve({ value: event, done: false });
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  return(): Promise<IteratorResult<unknown>> {
    this.end();
    return Promise.resolve({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this;
  }
}

function messageId(text: string): string {
  return /message="([^"]+)"/.exec(text)?.[1] ?? "opencode-entry";
}

class FakeApi implements OpenCodeApi {
  readonly streams: FakeEventStream[] = [];
  snapshot: OpenCodeSessionSnapshot = { exists: true, busy: false };
  readonly getSession = vi.fn(
    async (_sessionId: string, _signal?: AbortSignal): Promise<OpenCodeSessionSnapshot> =>
      this.snapshot,
  );
  readonly admit = vi.fn(async (sessionId: string, text: string): Promise<OpenCodeAdmission> => ({
    id: messageId(text),
    sessionID: sessionId,
    text,
    delivery: "queue",
  }));
  readonly subscribeEvents = vi.fn((signal?: AbortSignal) => {
    const stream = new FakeEventStream();
    this.streams.push(stream);
    signal?.addEventListener("abort", () => stream.end(), { once: true });
    return Promise.resolve(stream as AsyncIterable<unknown>);
  });
}

function makeRelay(): RelayHttpClient {
  return {
    heartbeat: vi.fn().mockResolvedValue({}),
    closeSession: vi.fn().mockResolvedValue({}),
    registerSession: vi.fn().mockResolvedValue({
      session: { sessionId: SESSION_ID, generation: 1 },
    }),
  } as unknown as RelayHttpClient;
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

function makeFixture(capabilities?: AdapterCapabilities, clock: Clock = { now: () => Date.now() }) {
  const api = new FakeApi();
  const relay = makeRelay();
  const adapter = new OpenCodeAdapter(
    api,
    relay,
    { ...config, heartbeatIntervalMs: 5 },
    capabilities,
    clock,
  );
  closers.push(() => adapter.close());
  return { adapter, api, relay };
}

async function makeIdleFixture() {
  const fixture = makeFixture();
  fixture.adapter.start();
  await expectState(fixture.adapter, "idle");
  return fixture;
}

function makeDispatcherFixture(clock = new MutableClock()) {
  const { adapter, api, relay } = makeFixture(undefined, clock);
  const database = contractDatabase();
  const store = new SQLiteMessageStore(database, clock);
  const sessions = new SessionStore(database, clock);
  sessions.register(
    {
      ...config,
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { ...adapter.capabilities },
    },
    false,
  );
  const dispatcher = new Dispatcher(
    store,
    sessions,
    new Map([[`${config.project}/${config.agentId}`, adapter]]),
    clock,
  );
  const pending = store.create(
    {
      project: message.project,
      from: message.from,
      to: message.to,
      text: message.text,
      expectsReply: message.expectsReply,
      idempotencyKey: message.idempotencyKey,
    },
    message.id,
    message.createdAt,
    message.threadId,
  ).message;
  closers.push(async () => {
    sessions.close();
    store.close();
  });
  return { adapter, api, relay, store, sessions, dispatcher, pending, clock };
}

async function expectState(adapter: OpenCodeAdapter, expected: string): Promise<void> {
  await vi.waitFor(async () => {
    expect(await adapter.state(SESSION_ID)).toBe(expected);
  });
}

describe("OpenCode queued prompt adapter", () => {
  it("admits the framed message through the queued prompt API", async () => {
    const { adapter, api } = await makeIdleFixture();

    await adapter.submit(SESSION_ID, message);

    expect(api.admit).toHaveBeenCalledWith(SESSION_ID, frameMessage(message), undefined);
  });

  it("returns delivered only for the admission bound to the visible session", async () => {
    const { adapter } = await makeIdleFixture();

    const receipt = await adapter.submit(SESSION_ID, message);

    expect(receipt).toEqual({
      state: "delivered",
      clientMessageId: message.id,
    });
  });

  it("does not accept another session's admission as delivery evidence", async () => {
    const { adapter, api } = await makeIdleFixture();
    api.admit.mockImplementationOnce(async (sessionId: string, text: string) => ({
      id: messageId(text),
      sessionID: "ses_other",
      text,
      delivery: "queue",
    }));

    await expect(adapter.submit(SESSION_ID, message)).rejects.toMatchObject({
      code: "DELIVERY_UNCERTAIN",
    });
    expect(adapter.capabilities.clientIdempotency).toBe(false);
  });

  it("does not accept an admission that echoes different text", async () => {
    const { adapter, api } = await makeIdleFixture();
    api.admit.mockImplementationOnce(async (sessionId: string) => ({
      id: message.id,
      sessionID: sessionId,
      text: "some other payload",
      delivery: "queue",
    }));

    await expect(adapter.submit(SESSION_ID, message)).rejects.toMatchObject({
      code: "DELIVERY_UNCERTAIN",
    });
    expect(adapter.capabilities.clientIdempotency).toBe(false);
  });

  it("does not accept a steered admission as queued delivery", async () => {
    const { adapter, api } = await makeIdleFixture();
    api.admit.mockImplementationOnce(async (sessionId: string, text: string) => ({
      id: messageId(text),
      sessionID: sessionId,
      text,
      delivery: "steer",
    }));

    await expect(adapter.submit(SESSION_ID, message)).rejects.toMatchObject({
      code: "DELIVERY_UNCERTAIN",
    });
  });

  it("caches known message-ID receipts without another admission", async () => {
    const { adapter, api } = await makeIdleFixture();

    const first = await adapter.submit(SESSION_ID, message);
    const retry = await adapter.submit(SESSION_ID, message);

    expect(retry).toBe(first);
    expect(api.admit).toHaveBeenCalledTimes(1);
  });

  it("marks post-transmission failures uncertain and never blindly reposts", async () => {
    const { adapter, api } = await makeIdleFixture();
    api.admit.mockRejectedValueOnce(new Error("socket reset after request transmission"));

    await expect(adapter.submit(SESSION_ID, message)).rejects.toMatchObject({
      code: "DELIVERY_UNCERTAIN",
      message: expect.stringContaining("operator inspection"),
    });
    expect(adapter.capabilities.clientIdempotency).toBe(false);

    await expect(adapter.submit(SESSION_ID, message)).rejects.toMatchObject({
      code: "DELIVERY_UNCERTAIN",
    });
    expect(api.admit).toHaveBeenCalledTimes(1);
  });

  it("preserves a known pre-transmission rejection for ordinary backoff", async () => {
    const { adapter, api } = await makeIdleFixture();
    api.admit.mockRejectedValueOnce(
      new SynloqError("INVALID_INPUT", "rejected before request transmission"),
    );

    await expect(adapter.submit(SESSION_ID, message)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(adapter.capabilities.clientIdempotency).toBe(true);

    await expect(adapter.submit(SESSION_ID, message)).resolves.toMatchObject({
      state: "delivered",
    });
    expect(api.admit).toHaveBeenCalledTimes(2);
  });

  it.each([
    [{ type: "session.execution.started", data: { sessionID: SESSION_ID } }, "busy"],
    [
      {
        type: "session.status",
        properties: { sessionID: SESSION_ID, status: { type: "busy" } },
      },
      "busy",
    ],
    [{ type: "session.status", data: { sessionID: SESSION_ID, status: { type: "busy" } } }, "busy"],
    [
      {
        type: "session.status",
        properties: { sessionID: SESSION_ID, status: { type: "idle" } },
      },
      "idle",
    ],
    [{ type: "session.idle", properties: { sessionID: SESSION_ID } }, "idle"],
    [{ type: "session.execution.succeeded", data: { sessionID: SESSION_ID } }, "idle"],
    [{ type: "session.execution.failed", data: { sessionID: SESSION_ID } }, "idle"],
    [{ type: "session.deleted", data: { sessionID: SESSION_ID } }, "closed"],
    [{ type: "session.deleted", properties: { sessionID: SESSION_ID } }, "closed"],
    [{ type: "session.deleted", properties: { info: { id: SESSION_ID } } }, "closed"],
  ] as const)("maps event to fresh state", async (event, expected) => {
    const { adapter, api } = makeFixture();
    await adapter.start();
    await expectState(adapter, "idle");

    api.streams[0]?.push(event);

    await expectState(adapter, expected);
  });

  it("ignores status, execution, and deletion events for every other session", async () => {
    const { adapter, api } = makeFixture();
    await adapter.start();
    await expectState(adapter, "idle");

    api.streams[0]?.push({
      type: "session.execution.started",
      data: { sessionID: "ses_other" },
    });
    api.streams[0]?.push({
      type: "session.idle",
      properties: { sessionID: "ses_other" },
    });
    api.streams[0]?.push({
      type: "session.deleted",
      data: { sessionID: "ses_other" },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await adapter.state(SESSION_ID)).toBe("idle");
  });

  it("does not revive a deleted session with a later stale idle event", async () => {
    const { adapter, api } = makeFixture();
    await adapter.start();
    await expectState(adapter, "idle");

    api.streams[0]?.push({
      type: "session.deleted",
      data: { sessionID: SESSION_ID },
    });
    await expectState(adapter, "closed");
    api.streams[0]?.push({
      type: "session.idle",
      properties: { sessionID: SESSION_ID },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await adapter.state(SESSION_ID)).toBe("closed");
  });

  it("changes the event-stream EOF state to unknown", async () => {
    const { adapter, api } = makeFixture();
    await adapter.start();
    await expectState(adapter, "idle");

    api.streams[0]?.end();

    await expectState(adapter, "unknown");
  });

  it("rereads the session markers after reconnect before reporting idle or busy", async () => {
    const { adapter, api } = makeFixture();
    let resolveReconnect!: (value: OpenCodeSessionSnapshot) => void;
    api.getSession.mockImplementationOnce(async () => ({ exists: true, busy: false }));
    await adapter.start();
    await expectState(adapter, "idle");

    api.getSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveReconnect = resolve;
        }),
    );
    api.streams[0]?.end();
    await expectState(adapter, "unknown");
    await vi.waitFor(() => expect(api.streams).toHaveLength(2), { timeout: 2_000 });
    await vi.waitFor(() => expect(api.getSession).toHaveBeenCalledTimes(2));

    expect(await adapter.state(SESSION_ID)).toBe("unknown");
    resolveReconnect({ exists: true, busy: true });
    await expectState(adapter, "busy");
  });

  it("reports closed when the session is gone after reconnect", async () => {
    const { adapter, api } = makeFixture();
    await adapter.start();
    await expectState(adapter, "idle");

    api.snapshot = { exists: false, busy: false };
    api.streams[0]?.end();
    await expectState(adapter, "unknown");
    await vi.waitFor(() => expect(api.getSession).toHaveBeenCalledTimes(2), { timeout: 2_000 });

    await expectState(adapter, "closed");
  });

  it("invalidates state and rereads markers on server.connected", async () => {
    const { adapter, api } = makeFixture();
    await adapter.start();
    await expectState(adapter, "idle");

    let resolveConnected!: (value: OpenCodeSessionSnapshot) => void;
    api.getSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveConnected = resolve;
        }),
    );
    api.streams[0]?.push({ type: "server.connected", data: {} });
    await expectState(adapter, "unknown");
    await vi.waitFor(() => expect(api.getSession).toHaveBeenCalledTimes(2));
    expect(await adapter.state(SESSION_ID)).toBe("unknown");

    resolveConnected({ exists: true, busy: false });
    await expectState(adapter, "idle");
  });

  it("verifies freshness on demand when the cached idle state is stale", async () => {
    const clock = new MutableClock();
    const { adapter, api } = makeFixture(undefined, clock);
    await adapter.start();
    await expectState(adapter, "idle");
    clock.advance(5_001);
    const callsBefore = api.getSession.mock.calls.length;

    await adapter.submit(SESSION_ID, message);

    expect(api.getSession.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(api.admit).toHaveBeenCalledTimes(1);
  });

  it("does not admit when the on-demand check reports busy", async () => {
    const clock = new MutableClock();
    const { adapter, api } = makeFixture(undefined, clock);
    await adapter.start();
    await expectState(adapter, "idle");
    clock.advance(5_001);
    api.snapshot = { exists: true, busy: true };

    await expect(adapter.submit(SESSION_ID, message)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(api.admit).not.toHaveBeenCalled();
  });

  it("does not admit when the on-demand check finds the session gone", async () => {
    const clock = new MutableClock();
    const { adapter, api } = makeFixture(undefined, clock);
    await adapter.start();
    await expectState(adapter, "idle");
    clock.advance(5_001);
    api.snapshot = { exists: false, busy: false };

    await expect(adapter.submit(SESSION_ID, message)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expectState(adapter, "closed");
    expect(api.admit).not.toHaveBeenCalled();
  });

  it("recovers from a stale busy observation through the on-demand check", async () => {
    const { adapter, api } = makeFixture();
    await adapter.start();
    await expectState(adapter, "idle");
    api.streams[0]?.push({
      type: "session.execution.started",
      data: { sessionID: SESSION_ID },
    });
    await expectState(adapter, "busy");
    // The turn ended but the completion event was missed; the markers say idle.
    api.snapshot = { exists: true, busy: false };

    await adapter.submit(SESSION_ID, message);

    expect(api.admit).toHaveBeenCalledTimes(1);
    await expectState(adapter, "idle");
  });

  it("keeps reporting the observed idle state past the freshness window", async () => {
    // Regression for #31 r2: decaying the REPORTED idle to "unknown" closed
    // the relay delivery gate (deliveryReady requires state "idle"), so a
    // quiet session never received pending messages.
    const clock = new MutableClock();
    const { adapter, relay } = makeFixture(undefined, clock);
    await adapter.start();
    await expectState(adapter, "idle");
    const heartbeat = vi.mocked(relay.heartbeat);
    const callsBefore = heartbeat.mock.calls.length;

    clock.advance(60_000);

    await vi.waitFor(() => {
      expect(heartbeat.mock.calls.length).toBeGreaterThan(callsBefore);
    });
    const reported = heartbeat.mock.calls.slice(callsBefore).map((call) => call[0].state);
    expect(reported.length).toBeGreaterThan(0);
    expect(new Set(reported)).toEqual(new Set(["idle"]));
  });

  it("refuses a closed session without an on-demand check", async () => {
    const { adapter, api } = makeFixture();
    await adapter.start();
    await expectState(adapter, "idle");
    api.streams[0]?.push({
      type: "session.deleted",
      data: { sessionID: SESSION_ID },
    });
    await expectState(adapter, "closed");
    const callsBefore = api.getSession.mock.calls.length;

    await expect(adapter.submit(SESSION_ID, message)).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining("closed"),
    });
    expect(api.getSession.mock.calls.length).toBe(callsBefore);
    expect(api.admit).not.toHaveBeenCalled();
  });

  it("close aborts event and heartbeat loops and reports closed", async () => {
    const { adapter, api, relay } = makeFixture();
    await adapter.start();
    await expectState(adapter, "idle");
    const heartbeat = vi.mocked(relay.heartbeat);

    await adapter.close();
    const callsAfterClose = heartbeat.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await adapter.state(SESSION_ID)).toBe("closed");
    expect(api.streams[0]?.isEnded).toBe(true);
    expect(relay.closeSession).toHaveBeenCalledWith({ sessionId: SESSION_ID });
    expect(heartbeat).toHaveBeenCalledTimes(callsAfterClose);
  });

  it("composes a standalone adapter through runOpenCodeAdapter", async () => {
    const api = new FakeApi();
    const relay = makeRelay();
    const adapter = await runOpenCodeAdapter(
      { ...config, baseUrl: "http://127.0.0.1:4096", heartbeatIntervalMs: 5 },
      relay,
      api,
    );
    closers.push(() => adapter.close());

    expect(relay.registerSession).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      protocolVersion: PROTOCOL_VERSION,
      capabilities: adapter.capabilities,
    });
    await expectState(adapter, "idle");
    expect(vi.mocked(relay.heartbeat)).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      state: "idle",
    });
  });

  it("close completes while a status observation never settles", async () => {
    const api = new FakeApi();
    api.getSession.mockImplementationOnce(() => new Promise(() => {}));
    const relay = makeRelay();
    const adapter = new OpenCodeAdapter(api, relay, {
      ...config,
      heartbeatIntervalMs: 5,
    });
    adapter.start();
    await vi.waitFor(() => expect(api.getSession).toHaveBeenCalledTimes(1));

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("close exceeded 200 ms")), 200);
    });
    try {
      await expect(Promise.race([adapter.close(), timeout])).resolves.toBeUndefined();
    } finally {
      if (timer) clearTimeout(timer);
    }
  });
});

describe("OpenCode dispatcher on-demand freshness", () => {
  it("verifies freshness on startup before the first admission", async () => {
    const { api, sessions, dispatcher, store, pending } = makeDispatcherFixture();
    sessions.heartbeat(config.project, config.agentId, SESSION_ID, "idle");

    await dispatcher.runOnce(config.project, config.agentId);

    expect(api.getSession).toHaveBeenCalled();
    expect(api.admit).toHaveBeenCalledTimes(1);
    expect(store.getMessage(pending.id)?.deliveryState).toBe("delivered");
  });

  it("performs zero admissions while the session markers report busy", async () => {
    const { api, sessions, dispatcher, store, pending } = makeDispatcherFixture();
    api.snapshot = { exists: true, busy: true };
    sessions.heartbeat(config.project, config.agentId, SESSION_ID, "busy");

    await dispatcher.runOnce(config.project, config.agentId);

    expect(api.admit).not.toHaveBeenCalled();
    expect(store.getMessage(pending.id)?.deliveryState).toBe("stored");
  });

  it("performs zero admissions after the stream ends while the markers report busy", async () => {
    const { adapter, api, sessions, dispatcher, store, pending } = makeDispatcherFixture();
    adapter.start();
    await expectState(adapter, "idle");
    api.streams[0]?.end();
    await expectState(adapter, "unknown");
    api.snapshot = { exists: true, busy: true };
    sessions.heartbeat(config.project, config.agentId, SESSION_ID, "unknown");

    await dispatcher.runOnce(config.project, config.agentId);

    expect(api.admit).not.toHaveBeenCalled();
    expect(store.getMessage(pending.id)?.deliveryState).toBe("stored");
  });

  it("performs zero admissions after the session is deleted", async () => {
    const { adapter, api, sessions, dispatcher, store, pending } = makeDispatcherFixture();
    adapter.start();
    await expectState(adapter, "idle");
    api.streams[0]?.push({
      type: "session.deleted",
      data: { sessionID: SESSION_ID },
    });
    await expectState(adapter, "closed");
    sessions.heartbeat(config.project, config.agentId, SESSION_ID, "closed");

    await dispatcher.runOnce(config.project, config.agentId);

    expect(api.admit).not.toHaveBeenCalled();
    expect(store.getMessage(pending.id)?.deliveryState).toBe("stored");
  });

  it("admits a stored message on a quiet idle session without any events", async () => {
    // Regression guard for the live M2 stall (#31): a session idle for hours
    // emits no events, so the cached observation decays — the on-demand
    // marker check must still admit the delivery.
    const { adapter, api, sessions, dispatcher, store, pending, clock } = makeDispatcherFixture();
    adapter.start();
    await expectState(adapter, "idle");
    clock.advance(3_600_000);
    sessions.heartbeat(config.project, config.agentId, SESSION_ID, "idle");

    await dispatcher.runOnce(config.project, config.agentId);

    expect(api.admit).toHaveBeenCalledTimes(1);
    expect(store.getMessage(pending.id)?.deliveryState).toBe("delivered");
  });
});

describe("createOpenCodeApi wire contract", () => {
  const baseUrl = "http://127.0.0.1:28894";

  function fetchReturning(status: number, body: unknown) {
    return vi.fn(async () => new Response(JSON.stringify(body), { status }));
  }

  it("rejects a non-loopback base URL before any request", () => {
    expect(() => createOpenCodeApi("http://198.51.100.7:28894")).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it("reads busy markers from the enveloped session response", async () => {
    const fetchImpl = fetchReturning(200, {
      data: { id: SESSION_ID, time: { busy: 20, idle: 10 } },
    });
    const api = createOpenCodeApi(baseUrl, { fetch: fetchImpl as unknown as typeof fetch });

    await expect(api.getSession(SESSION_ID)).resolves.toEqual({ exists: true, busy: true });
    expect(fetchImpl).toHaveBeenCalledWith(
      `${baseUrl}/api/session/${SESSION_ID}`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("reports idle when the session never ran a turn", async () => {
    const fetchImpl = fetchReturning(200, { data: { id: SESSION_ID, time: {} } });
    const api = createOpenCodeApi(baseUrl, { fetch: fetchImpl as unknown as typeof fetch });

    await expect(api.getSession(SESSION_ID)).resolves.toEqual({ exists: true, busy: false });
  });

  it("reports a missing session as not existing", async () => {
    const fetchImpl = fetchReturning(404, undefined);
    const api = createOpenCodeApi(baseUrl, { fetch: fetchImpl as unknown as typeof fetch });

    await expect(api.getSession(SESSION_ID)).resolves.toEqual({ exists: false, busy: false });
  });

  it("admits with a flat queued body that schedules execution", async () => {
    const fetchImpl = fetchReturning(200, {
      data: {
        id: "msg_1",
        sessionID: SESSION_ID,
        time: { created: 1 },
        type: "user",
        payload: { text: "hello" },
        delivery: "queue",
      },
    });
    const api = createOpenCodeApi(baseUrl, { fetch: fetchImpl as unknown as typeof fetch });

    const admission = await api.admit(SESSION_ID, "hello");

    expect(fetchImpl).toHaveBeenCalledWith(
      `${baseUrl}/api/session/${SESSION_ID}/prompt`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ text: "hello", delivery: "queue", resume: true }),
      }),
    );
    expect(admission).toEqual({
      id: "msg_1",
      sessionID: SESSION_ID,
      text: "hello",
      delivery: "queue",
    });
  });

  it("parses server-sent events with data payloads", async () => {
    const events = [
      { id: "evt_1", type: "server.connected", data: {} },
      { id: "evt_2", type: "session.execution.started", data: { sessionID: SESSION_ID } },
    ];
    const payload = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
    const fetchImpl = vi.fn(
      async () =>
        new Response(payload, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const api = createOpenCodeApi(baseUrl, { fetch: fetchImpl as unknown as typeof fetch });

    const stream = await api.subscribeEvents(new AbortController().signal);
    const seen: unknown[] = [];
    for await (const event of stream) seen.push(event);

    expect(seen).toEqual(events);
    expect(fetchImpl).toHaveBeenCalledWith(
      `${baseUrl}/api/event`,
      expect.objectContaining({
        headers: expect.objectContaining({ accept: "text/event-stream" }),
      }),
    );
  });

  it("fails the event subscription on a non-OK response", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 401 }));
    const api = createOpenCodeApi(baseUrl, { fetch: fetchImpl as unknown as typeof fetch });

    await expect(api.subscribeEvents(new AbortController().signal)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });
});
