import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KimiWorkAdapter,
  runKimiWorkAdapter,
  type KimiWorkControl,
} from "../../src/adapters/kimi-work.js";
import type { Clock } from "../../src/adapters/types.js";
import { SynloqError } from "../../src/domain/errors.js";
import type { Message } from "../../src/domain/message.js";
import { PROTOCOL_VERSION } from "../../src/domain/session.js";
import type {
  KimiWorkBinding,
  KimiWorkHistoryEntry,
  KimiWorkMetadata,
  KimiWorkSendResult,
} from "../../src/host/kimi-work/control-client.js";
import { KimiWorkRpcError } from "../../src/host/kimi-work/json-rpc.js";
import { formatKimiWorkPrompt } from "../../src/host/kimi-work/prompt.js";
import type { RelayHttpClient } from "../../src/transport/http-client.js";
import { MutableClock } from "./contract.js";

const binding: KimiWorkBinding = {
  workAgentId: "main",
  conversationKey: "agent:main:main:conversation:d7be2b2c-edfc-4fc7-a010-1e7af6465138",
  sessionKey: "agent:main:main",
  workspacePath: "I:\\git\\Synloq",
  kernelSessionId: "conv-587ed547d4b9851e059afe14",
};
const config = {
  ...binding,
  project: "synloq",
  agentId: "reviewer",
  heartbeatIntervalMs: 5,
  reconciliationDelayMs: 1,
};
const message: Message = {
  id: "f959f250-7d84-4c81-b9f2-9b600e077f6e",
  threadId: "ad5d204f-1e6e-4b71-8283-f3224c5a742a",
  project: "synloq",
  from: "product-owner",
  to: "reviewer",
  text: "[QUESTION]\nCheck visible delivery.",
  expectsReply: true,
  idempotencyKey: "kimi-adapter-test-1",
  createdAt: "2026-11-11T12:00:00.000Z",
  deliveryState: "stored",
};

function metadata(override: Record<string, unknown> = {}): KimiWorkMetadata {
  return {
    conversationKey: binding.conversationKey,
    sessionKey: binding.sessionKey,
    kernelSessionId: binding.kernelSessionId!,
    origin: "client",
    workspacePath: binding.workspacePath,
    ...override,
  };
}

function accepted(turnId = "work-turn-uuid"): KimiWorkSendResult {
  return {
    accepted: true,
    conversationKey: binding.conversationKey,
    kernelSessionId: binding.kernelSessionId!,
    turnId,
  };
}

function visible(id: string, text = formatKimiWorkPrompt(message, 3)): KimiWorkHistoryEntry {
  return { id, turnId: `turn-${id}`, role: "user", status: "complete", text };
}

class FakeControl implements KimiWorkControl {
  readonly metadata = vi.fn(async () => metadata());
  readonly busy = vi.fn(async () => false);
  readonly messages = vi.fn(async (): Promise<KimiWorkHistoryEntry[]> => []);
  readonly send = vi.fn(async (): Promise<KimiWorkSendResult> => accepted());
}

function makeRelay() {
  return {
    heartbeat: vi.fn().mockResolvedValue({}),
    closeSession: vi.fn().mockResolvedValue({}),
    acknowledge: vi.fn().mockResolvedValue({}),
    registerSession: vi.fn().mockResolvedValue({
      session: {
        project: config.project,
        agentId: config.agentId,
        sessionId: binding.conversationKey,
        generation: 3,
      },
    }),
  } as unknown as RelayHttpClient;
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

function fixture(options: { clock?: Clock; reconnect?: () => Promise<KimiWorkControl> } = {}) {
  const control = new FakeControl();
  const relay = makeRelay();
  const adapter = new KimiWorkAdapter(control, relay, config, {
    heartbeatIntervalMs: 5,
    reconciliationDelayMs: 1,
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.reconnect ? { reconnect: options.reconnect } : {}),
  });
  closers.push(() => adapter.close());
  return { adapter, control, relay };
}

async function idleFixture(options: { clock?: Clock } = {}) {
  const value = fixture(options);
  value.adapter.start();
  await vi.waitFor(async () => {
    expect(await value.adapter.state(binding.conversationKey)).toBe("idle");
  });
  return value;
}

describe("KimiWorkAdapter state and registration", () => {
  it("maps exact idle/busy metadata and expires stale idle", async () => {
    const clock = new MutableClock();
    const { adapter, control } = await idleFixture({ clock });
    control.busy.mockResolvedValue(true);
    await vi.waitFor(async () => expect(await adapter.state(binding.conversationKey)).toBe("busy"));

    control.busy.mockResolvedValue(false);
    await vi.waitFor(async () => expect(await adapter.state(binding.conversationKey)).toBe("idle"));
    clock.advance(5_001);
    expect(await adapter.state(binding.conversationKey)).toBe("unknown");
    expect(adapter.capabilities).toEqual({
      activeDelivery: true,
      stateReporting: true,
      clientIdempotency: false,
    });
  });

  it.each([
    [
      "conversation",
      { conversationKey: "agent:main:main:conversation:02ffbece-ba58-4e17-8c52-acf9615c9ccb" },
    ],
    ["session", { sessionKey: "agent:main:other" }],
    ["kernel", { kernelSessionId: "conv-other" }],
    ["origin", { origin: "sdk" }],
    ["workspace", { workspacePath: "I:\\git\\Other" }],
  ])("fails closed for wrong %s identity without registration or send", async (_name, override) => {
    const control = new FakeControl();
    control.metadata.mockResolvedValue(metadata(override));
    const relay = makeRelay();

    await expect(runKimiWorkAdapter(config, relay, { control })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(relay.registerSession).not.toHaveBeenCalled();
    expect(control.send).not.toHaveBeenCalled();
  });

  it("registers exact capabilities and verifies relay identity", async () => {
    const control = new FakeControl();
    const relay = makeRelay();
    const adapter = await runKimiWorkAdapter(config, relay, { control });
    closers.push(() => adapter.close());

    expect(relay.registerSession).toHaveBeenCalledWith({
      sessionId: binding.conversationKey,
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { activeDelivery: true, stateReporting: true, clientIdempotency: false },
    });
    expect(adapter.sessionBinding).toEqual({ sessionId: binding.conversationKey, generation: 3 });
  });

  it("opens exactly one initial host connection through the factory", async () => {
    const control = new FakeControl();
    const close = vi.fn(async () => undefined);
    const connect = vi.fn(async () => ({ control, close }));
    const relay = makeRelay();
    const adapter = await runKimiWorkAdapter(config, relay, { connect });
    closers.push(() => adapter.close());

    expect(connect).toHaveBeenCalledTimes(1);
    await adapter.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("observes unknown on transport failure and reconnects with bounded backoff", async () => {
    const good = new FakeControl();
    const reconnect = vi.fn(async () => good);
    const { adapter, control } = fixture({ reconnect });
    control.metadata.mockRejectedValueOnce(new Error("socket closed"));
    adapter.start();

    await vi.waitFor(async () => expect(await adapter.state(binding.conversationKey)).toBe("idle"));
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it("closes only the Synloq registration and stops heartbeat", async () => {
    const { adapter, relay, control } = await idleFixture();
    await adapter.close();
    const calls = control.metadata.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await adapter.state(binding.conversationKey)).toBe("closed");
    expect(control.metadata.mock.calls.length).toBe(calls);
    expect(relay.closeSession).toHaveBeenCalledTimes(1);
  });
});

describe("KimiWorkAdapter submission", () => {
  it("sends the exact generated prompt once without automatic acknowledgement", async () => {
    const { adapter, control, relay } = await idleFixture();

    await expect(
      adapter.submit(binding.conversationKey, message, { generation: 3 }),
    ).resolves.toEqual({ state: "delivered", clientMessageId: "work-turn-uuid" });
    expect(control.send).toHaveBeenCalledWith(binding, formatKimiWorkPrompt(message, 3), undefined);
    expect(control.send).toHaveBeenCalledTimes(1);
    expect(relay.acknowledge).not.toHaveBeenCalled();
  });

  it("memoizes success without another visible mutation", async () => {
    const { adapter, control } = await idleFixture();
    const first = await adapter.submit(binding.conversationKey, message, { generation: 3 });
    const second = await adapter.submit(binding.conversationKey, message, { generation: 3 });

    expect(second).toBe(first);
    expect(control.send).toHaveBeenCalledTimes(1);
  });

  it("returns an existing matching frame without another mutation", async () => {
    const { adapter, control } = await idleFixture();
    control.messages.mockResolvedValue([visible("existing")]);

    await expect(
      adapter.submit(binding.conversationKey, message, { generation: 3 }),
    ).resolves.toEqual({ state: "delivered", clientMessageId: "turn-existing" });
    expect(control.send).not.toHaveBeenCalled();
  });

  it("revalidates busy immediately before admission and never steers", async () => {
    const { adapter, control } = await idleFixture();
    control.busy.mockResolvedValue(true);

    await expect(
      adapter.submit(binding.conversationKey, message, { generation: 3 }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(control.send).not.toHaveBeenCalled();
  });

  it("treats a definite busy RPC as retryable without reconciliation", async () => {
    const { adapter, control } = await idleFixture();
    control.send.mockRejectedValueOnce(new KimiWorkRpcError(-32009, "CONVERSATION_BUSY"));

    await expect(
      adapter.submit(binding.conversationKey, message, { generation: 3 }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(control.send).toHaveBeenCalledTimes(1);
    expect(control.messages).toHaveBeenCalledTimes(1);
  });

  it("reconciles one matching history entry after an ambiguous send", async () => {
    const { adapter, control } = await idleFixture();
    control.send.mockRejectedValueOnce(new Error("timeout after write"));
    control.messages.mockResolvedValueOnce([]).mockResolvedValueOnce([visible("reconciled")]);

    await expect(
      adapter.submit(binding.conversationKey, message, { generation: 3 }),
    ).resolves.toEqual({ state: "delivered", clientMessageId: "turn-reconciled" });
    expect(control.send).toHaveBeenCalledTimes(1);
    expect(control.messages).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["no match", []],
    ["multiple matches", [visible("one"), visible("two")]],
  ])("quarantines an ambiguous result with %s and never resubmits", async (_name, history) => {
    const { adapter, control } = await idleFixture();
    control.send.mockRejectedValueOnce(new Error("timeout after write"));
    control.messages.mockResolvedValueOnce([]).mockResolvedValue(history);

    await expect(
      adapter.submit(binding.conversationKey, message, { generation: 3 }),
    ).rejects.toMatchObject({ code: "DELIVERY_UNCERTAIN" });
    await expect(
      adapter.submit(binding.conversationKey, message, { generation: 3 }),
    ).rejects.toMatchObject({ code: "DELIVERY_UNCERTAIN" });
    expect(control.send).toHaveBeenCalledTimes(1);
    expect(control.messages).toHaveBeenCalledTimes(history.length > 1 ? 2 : 4);
  });

  it("rejects another session before reading history or sending", async () => {
    const { adapter, control } = await idleFixture();

    await expect(
      adapter.submit("agent:main:main:conversation:02ffbece-ba58-4e17-8c52-acf9615c9ccb", message, {
        generation: 3,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(control.messages).not.toHaveBeenCalled();
    expect(control.send).not.toHaveBeenCalled();
  });
});
