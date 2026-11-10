import type { OpencodeClient as OpenCodeClient } from "@opencode-ai/sdk/client";
import type { OpencodeClient as OpenCodeV2Client } from "@opencode-ai/sdk/v2/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCodeAdapter, runOpenCodeAdapter } from "../../src/adapters/opencode.js";
import { frameMessage } from "../../src/adapters/reference.js";
import { SynloqError } from "../../src/domain/errors.js";
import type { Message } from "../../src/domain/message.js";
import { PROTOCOL_VERSION, type AdapterCapabilities } from "../../src/domain/session.js";
import type { RelayHttpClient } from "../../src/transport/http-client.js";

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

interface PromptParameters {
  sessionID: string;
  prompt: { text: string };
  delivery: "queue";
  resume: false;
}

interface AdmittedEntry {
  admittedSeq: number;
  id: string;
  sessionID: string;
  prompt: { text: string };
  delivery: "queue";
  timeCreated: number;
}

type FakeEvent = unknown;

class FakeEventStream implements AsyncIterable<FakeEvent> {
  private readonly events: FakeEvent[] = [];
  private readonly waiters: Array<(result: IteratorResult<FakeEvent>) => void> = [];
  private ended = false;

  get isEnded(): boolean {
    return this.ended;
  }

  push(event: FakeEvent): void {
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

  next(): Promise<IteratorResult<FakeEvent>> {
    const event = this.events.shift();
    if (event !== undefined) return Promise.resolve({ value: event, done: false });
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  return(): Promise<IteratorResult<FakeEvent>> {
    this.end();
    return Promise.resolve({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<FakeEvent> {
    return this;
  }
}

function messageId(parameters: PromptParameters): string {
  return /message="([^"]+)"/.exec(parameters.prompt.text)?.[1] ?? "opencode-entry";
}

function admission(parameters: PromptParameters): { data: { data: AdmittedEntry } } {
  return {
    data: {
      data: {
        admittedSeq: 1,
        id: messageId(parameters),
        sessionID: parameters.sessionID,
        prompt: parameters.prompt,
        delivery: "queue",
        timeCreated: 1,
      },
    },
  };
}

class FakeSdk {
  readonly streams: FakeEventStream[] = [];
  readonly prompt = vi.fn(async (parameters: PromptParameters, _options: unknown) =>
    admission(parameters),
  );
  readonly status = vi.fn(
    async (_input: unknown): Promise<{ data: Record<string, { type: string }> }> => ({
      data: { [SESSION_ID]: { type: "idle" } },
    }),
  );
  readonly subscribe = vi.fn((options?: { signal?: AbortSignal }) => {
    const stream = new FakeEventStream();
    this.streams.push(stream);
    options?.signal?.addEventListener("abort", () => stream.end(), { once: true });
    return Promise.resolve({ stream });
  });

  asNormalClient(): OpenCodeClient {
    return {
      session: { status: this.status },
      event: { subscribe: this.subscribe },
    } as unknown as OpenCodeClient;
  }

  asV2Client(): OpenCodeV2Client {
    return { v2: { session: { prompt: this.prompt } } } as unknown as OpenCodeV2Client;
  }
}

function makeRelay(): RelayHttpClient {
  return {
    heartbeat: vi.fn().mockResolvedValue({}),
    closeSession: vi.fn().mockResolvedValue({}),
    registerSession: vi.fn().mockResolvedValue({}),
  } as unknown as RelayHttpClient;
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

function makeFixture(capabilities?: AdapterCapabilities) {
  const sdk = new FakeSdk();
  const relay = makeRelay();
  const adapter = new OpenCodeAdapter(
    sdk.asV2Client(),
    sdk.asNormalClient(),
    relay,
    { ...config, heartbeatIntervalMs: 5 },
    capabilities,
  );
  closers.push(() => adapter.close());
  return { adapter, sdk, relay };
}

async function expectState(adapter: OpenCodeAdapter, expected: string): Promise<void> {
  await vi.waitFor(async () => {
    expect(await adapter.state(SESSION_ID)).toBe(expected);
  });
}

describe("OpenCode queued prompt adapter", () => {
  it("uses queue delivery and never steer", async () => {
    const { adapter, sdk } = makeFixture();

    await adapter.submit(SESSION_ID, message);

    expect(sdk.prompt).toHaveBeenCalledWith(
      {
        sessionID: SESSION_ID,
        prompt: { text: frameMessage(message) },
        delivery: "queue",
        resume: false,
      },
      { throwOnError: true },
    );
  });

  it("returns delivered only for the new inbox entry bound to the visible session", async () => {
    const { adapter } = makeFixture();

    const receipt = await adapter.submit(SESSION_ID, message);

    expect(receipt).toEqual({ state: "delivered", clientMessageId: message.id });
  });

  it("does not accept another session's inbox entry as delivery evidence", async () => {
    const { adapter, sdk } = makeFixture();
    sdk.prompt.mockImplementationOnce(async (parameters) => {
      const response = admission(parameters);
      response.data.data.sessionID = "ses_other";
      return response;
    });

    await expect(adapter.submit(SESSION_ID, message)).rejects.toMatchObject({
      code: "DELIVERY_UNCERTAIN",
    });
    expect(adapter.capabilities.clientIdempotency).toBe(false);
  });

  it("caches known message-ID receipts without another prompt", async () => {
    const { adapter, sdk } = makeFixture();

    const first = await adapter.submit(SESSION_ID, message);
    const retry = await adapter.submit(SESSION_ID, message);

    expect(retry).toBe(first);
    expect(sdk.prompt).toHaveBeenCalledTimes(1);
  });

  it("marks post-transmission failures uncertain and never blindly reposts", async () => {
    const { adapter, sdk } = makeFixture();
    sdk.prompt.mockRejectedValueOnce(new Error("socket reset after request transmission"));

    await expect(adapter.submit(SESSION_ID, message)).rejects.toMatchObject({
      code: "DELIVERY_UNCERTAIN",
      message: expect.stringContaining("operator inspection"),
    });
    expect(adapter.capabilities.clientIdempotency).toBe(false);

    await expect(adapter.submit(SESSION_ID, message)).rejects.toMatchObject({
      code: "DELIVERY_UNCERTAIN",
    });
    expect(sdk.prompt).toHaveBeenCalledTimes(1);
  });

  it("preserves a known pre-transmission rejection for ordinary backoff", async () => {
    const { adapter, sdk } = makeFixture();
    sdk.prompt.mockRejectedValueOnce(
      new SynloqError("INVALID_INPUT", "rejected before request transmission"),
    );

    await expect(adapter.submit(SESSION_ID, message)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(adapter.capabilities.clientIdempotency).toBe(true);

    await expect(adapter.submit(SESSION_ID, message)).resolves.toMatchObject({
      state: "delivered",
    });
    expect(sdk.prompt).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      {
        type: "session.status",
        properties: { sessionID: SESSION_ID, status: { type: "busy" } },
      },
      "busy",
    ],
    [
      {
        type: "session.status",
        properties: { sessionID: SESSION_ID, status: { type: "idle" } },
      },
      "idle",
    ],
    [{ type: "session.idle", properties: { sessionID: SESSION_ID } }, "idle"],
    [{ type: "session.deleted", properties: { sessionID: SESSION_ID } }, "closed"],
    [{ type: "session.deleted", properties: { info: { id: SESSION_ID } } }, "closed"],
  ] as const)("maps event to fresh state", async (event, expected) => {
    const { adapter, sdk } = makeFixture();
    await adapter.start();
    await expectState(adapter, "idle");

    sdk.streams[0]?.push(event);

    await expectState(adapter, expected);
  });

  it("ignores status, idle, and deletion events for every other session", async () => {
    const { adapter, sdk } = makeFixture();
    await adapter.start();
    await expectState(adapter, "idle");

    sdk.streams[0]?.push({
      type: "session.status",
      properties: { sessionID: "ses_other", status: { type: "busy" } },
    });
    sdk.streams[0]?.push({ type: "session.idle", properties: { sessionID: "ses_other" } });
    sdk.streams[0]?.push({ type: "session.deleted", properties: { sessionID: "ses_other" } });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await adapter.state(SESSION_ID)).toBe("idle");
  });

  it("does not revive a deleted session with a later stale idle event", async () => {
    const { adapter, sdk } = makeFixture();
    await adapter.start();
    await expectState(adapter, "idle");

    sdk.streams[0]?.push({ type: "session.deleted", properties: { sessionID: SESSION_ID } });
    await expectState(adapter, "closed");
    sdk.streams[0]?.push({ type: "session.idle", properties: { sessionID: SESSION_ID } });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await adapter.state(SESSION_ID)).toBe("closed");
  });

  it("changes the event-stream EOF state to unknown", async () => {
    const { adapter, sdk } = makeFixture();
    await adapter.start();
    await expectState(adapter, "idle");

    sdk.streams[0]?.end();

    await expectState(adapter, "unknown");
  });

  it("requires a fresh matching status after reconnect before reporting idle or busy", async () => {
    const { adapter, sdk } = makeFixture();
    let resolveReconnectStatus!: (value: { data: Record<string, { type: string }> }) => void;
    sdk.status
      .mockResolvedValueOnce({ data: { [SESSION_ID]: { type: "idle" } } })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveReconnectStatus = resolve;
          }),
      );
    await adapter.start();
    await expectState(adapter, "idle");

    sdk.streams[0]?.end();
    await expectState(adapter, "unknown");
    await vi.waitFor(() => expect(sdk.streams).toHaveLength(2), { timeout: 2_000 });
    await vi.waitFor(() => expect(sdk.status).toHaveBeenCalledTimes(2));

    expect(await adapter.state(SESSION_ID)).toBe("unknown");
    expect(sdk.status).toHaveBeenNthCalledWith(2, {});
    resolveReconnectStatus({ data: { [SESSION_ID]: { type: "busy" } } });
    await expectState(adapter, "busy");
  });

  it("does not revive idle from buffered events when reconnect status has no matching entry", async () => {
    const { adapter, sdk } = makeFixture();
    sdk.status
      .mockResolvedValueOnce({ data: { [SESSION_ID]: { type: "idle" } } })
      .mockResolvedValueOnce({ data: { ses_other: { type: "idle" } } });
    await adapter.start();
    await expectState(adapter, "idle");

    sdk.streams[0]?.end();
    await vi.waitFor(() => expect(sdk.streams).toHaveLength(2), { timeout: 2_000 });
    await vi.waitFor(() => expect(sdk.status).toHaveBeenCalledTimes(2));
    sdk.streams[1]?.push({ type: "session.idle", properties: { sessionID: SESSION_ID } });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await adapter.state(SESSION_ID)).toBe("unknown");
  });

  it("invalidates state and rereads status on server.connected", async () => {
    const { adapter, sdk } = makeFixture();
    let resolveConnectedStatus!: (value: { data: Record<string, { type: string }> }) => void;
    sdk.status
      .mockResolvedValueOnce({ data: { [SESSION_ID]: { type: "idle" } } })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveConnectedStatus = resolve;
          }),
      );
    await adapter.start();
    await expectState(adapter, "idle");

    sdk.streams[0]?.push({ type: "server.connected", properties: {} });
    await expectState(adapter, "unknown");
    await vi.waitFor(() => expect(sdk.status).toHaveBeenCalledTimes(2));
    expect(await adapter.state(SESSION_ID)).toBe("unknown");

    resolveConnectedStatus({ data: { [SESSION_ID]: { type: "idle" } } });
    await expectState(adapter, "idle");
  });

  it("close aborts event and heartbeat loops and reports closed", async () => {
    const { adapter, sdk, relay } = makeFixture();
    await adapter.start();
    await expectState(adapter, "idle");
    const heartbeat = vi.mocked(relay.heartbeat);

    await adapter.close();
    const callsAfterClose = heartbeat.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await adapter.state(SESSION_ID)).toBe("closed");
    expect(sdk.streams[0]?.isEnded).toBe(true);
    expect(relay.closeSession).toHaveBeenCalledWith({ sessionId: SESSION_ID });
    expect(heartbeat).toHaveBeenCalledTimes(callsAfterClose);
  });

  it("composes a standalone adapter through runOpenCodeAdapter", async () => {
    const sdk = new FakeSdk();
    const relay = makeRelay();
    const adapter = await runOpenCodeAdapter(
      { ...config, baseUrl: "http://127.0.0.1:4096", heartbeatIntervalMs: 5 },
      relay,
      { openCode: sdk.asV2Client(), client: sdk.asNormalClient() },
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
});
