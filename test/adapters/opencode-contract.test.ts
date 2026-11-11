import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { OpencodeClient as OpenCodeClient } from "@opencode-ai/sdk/client";
import type { OpencodeClient as OpenCodeV2Client } from "@opencode-ai/sdk/v2/client";
import { expect, it, vi } from "vitest";
import { OpenCodeAdapter } from "../../src/adapters/opencode.js";
import type { DeliveryAdapter, DeliveryReceipt } from "../../src/adapters/types.js";
import { SynloqError } from "../../src/domain/errors.js";
import type { Message } from "../../src/domain/message.js";
import { PROTOCOL_VERSION, type SessionState } from "../../src/domain/session.js";
import { Dispatcher } from "../../src/relay/dispatcher.js";
import { SQLiteMessageStore } from "../../src/storage/message-store.js";
import { SessionStore } from "../../src/storage/session-store.js";
import type { RelayHttpClient } from "../../src/transport/http-client.js";
import {
  CONTRACT_AGENT,
  CONTRACT_PROJECT,
  CONTRACT_SESSION,
  MutableClock,
  contractCapabilities,
  contractDatabase,
  contractRegistration,
  runAdapterContract,
  type Harness,
  type VisibleEntry,
} from "./contract.js";

interface PromptParameters {
  sessionID: string;
  prompt: { text: string };
}

class ContractEventStream implements AsyncIterable<unknown> {
  private readonly events: unknown[] = [];
  private readonly waiters: Array<(result: IteratorResult<unknown>) => void> = [];
  private ended = false;

  push(event: unknown): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.events.push(event);
  }

  end(): void {
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

class ObservedOpenCodeContractAdapter implements DeliveryAdapter {
  constructor(
    private readonly delegate: OpenCodeAdapter,
    private readonly expectedState: () => SessionState,
  ) {}

  get capabilities() {
    return this.delegate.capabilities;
  }

  state(sessionId: string): Promise<SessionState> {
    return this.delegate.state(sessionId);
  }

  async submit(sessionId: string, message: Message): Promise<DeliveryReceipt> {
    const expected = this.expectedState();
    await vi.waitFor(
      async () => {
        expect(await this.delegate.state(sessionId)).toBe(expected);
      },
      { timeout: 1_000, interval: 1 },
    );
    return this.delegate.submit(sessionId, message);
  }
}

runAdapterContract("OpenCodeAdapter delivery contract", (capabilities = contractCapabilities()) => {
  const clock = new MutableClock();
  const database = contractDatabase();
  const store = new SQLiteMessageStore(database, clock);
  const sessions = new SessionStore(database, clock);
  const visible: VisibleEntry[] = [];
  const failures = new Set<string>();
  const prompt = vi.fn(async (parameters: PromptParameters) => {
    const messageId = /message="([^"]+)"/.exec(parameters.prompt.text)?.[1];
    if (!messageId) throw new Error("fake OpenCode prompt has no Synloq message ID");
    if (failures.delete(messageId)) {
      // The fake rejects before transmission, which is safe for ordinary retry backoff.
      throw new SynloqError("INVALID_INPUT", `forced pre-transmission failure for ${messageId}`);
    }
    const entry = { id: messageId, content: parameters.prompt.text };
    visible.push(entry);
    return {
      data: {
        data: {
          admittedSeq: visible.length,
          id: messageId,
          sessionID: parameters.sessionID,
          prompt: parameters.prompt,
          delivery: "queue",
          timeCreated: visible.length,
        },
      },
    };
  });
  const openCode = { v2: { session: { prompt } } } as unknown as OpenCodeV2Client;
  const stream = new ContractEventStream();
  const client = {
    session: {
      status: vi.fn(async () => ({ data: { [CONTRACT_SESSION]: { type: "idle" } } })),
    },
    event: {
      subscribe: vi.fn((options?: { signal?: AbortSignal }) => {
        options?.signal?.addEventListener("abort", () => stream.end(), { once: true });
        return Promise.resolve({ stream });
      }),
    },
  } as unknown as OpenCodeClient;
  const relay = {
    heartbeat: vi.fn().mockResolvedValue({}),
    closeSession: vi.fn().mockResolvedValue({}),
  } as unknown as RelayHttpClient;
  const adapter = new OpenCodeAdapter(
    openCode,
    client,
    relay,
    { project: CONTRACT_PROJECT, agentId: CONTRACT_AGENT, sessionId: CONTRACT_SESSION },
    capabilities,
    clock,
  );
  sessions.register(contractRegistration(CONTRACT_SESSION, capabilities), false);
  let expectedState: SessionState = "idle";
  const observedAdapter = new ObservedOpenCodeContractAdapter(adapter, () => expectedState);
  adapter.start();
  const dispatcher = new Dispatcher(
    store,
    sessions,
    new Map([[`${CONTRACT_PROJECT}/${CONTRACT_AGENT}`, observedAdapter]]),
    clock,
  );

  const harness: Harness = {
    adapter: observedAdapter,
    sessions,
    store,
    clock,
    visible,
    dispatcher,
    setState(state) {
      sessions.heartbeat(CONTRACT_PROJECT, CONTRACT_AGENT, CONTRACT_SESSION, state);
      if (state === "idle" || state === "busy") {
        expectedState = state;
        stream.push(
          state === "idle"
            ? { type: "session.idle", properties: { sessionID: CONTRACT_SESSION } }
            : {
                type: "session.status",
                properties: { sessionID: CONTRACT_SESSION, status: { type: "busy" } },
              },
        );
      }
    },
    failNext(messageId) {
      failures.add(messageId);
    },
    close() {
      void adapter.close();
      sessions.close();
      store.close();
    },
  };
  return harness;
});

it("uses queued delivery and contains no steering call path", () => {
  const sourcePath = fileURLToPath(new URL("../../src/adapters/opencode.ts", import.meta.url));
  const source = readFileSync(sourcePath, "utf8");

  expect(source).toContain('delivery: "queue"');
  expect(source).not.toContain('delivery: "steer"');
});
