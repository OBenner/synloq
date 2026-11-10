import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { vi } from "vitest";
import {
  ClaudeChannelAdapter,
  type ClaudeChannelNotification,
} from "../../src/adapters/claude-channel.js";
import type { DeliveryAdapter, DeliveryReceipt } from "../../src/adapters/types.js";
import type { Message } from "../../src/domain/message.js";
import { PROTOCOL_VERSION, type SessionState } from "../../src/domain/session.js";
import { Dispatcher } from "../../src/relay/dispatcher.js";
import { SQLiteMessageStore } from "../../src/storage/message-store.js";
import { SessionStore } from "../../src/storage/session-store.js";
import {
  CONTRACT_AGENT,
  CONTRACT_PROJECT,
  CONTRACT_SESSION,
  MutableClock,
  contractCapabilities,
  contractRegistration,
  runAdapterContract,
  type Harness,
  type VisibleEntry,
} from "./contract.js";

class FakeHookContractAdapter implements DeliveryAdapter {
  private readonly receipts = new Map<string, DeliveryReceipt>();

  constructor(
    private readonly channel: ClaudeChannelAdapter,
    private readonly visible: VisibleEntry[],
  ) {}

  get capabilities() {
    return this.channel.capabilities;
  }

  state(sessionId: string): Promise<SessionState> {
    return this.channel.state(sessionId);
  }

  async submit(sessionId: string, message: Message): Promise<DeliveryReceipt> {
    const original = this.receipts.get(message.id);
    if (original) return original;

    await this.channel.submit(sessionId, message);
    const visible = this.visible.find((entry) => entry.id === message.id);
    if (!visible) throw new Error("fake Claude hook did not observe visible admission");

    // The real adapter remains submitted here. Fake visible admission lets the
    // shared synchronous contract observe the subsequent delivered receipt.
    const receipt: DeliveryReceipt = { state: "delivered", clientMessageId: message.id };
    this.receipts.set(message.id, receipt);
    return receipt;
  }
}

runAdapterContract(
  "ClaudeChannelAdapter delivery contract",
  (capabilities = contractCapabilities()) => {
    const clock = new MutableClock();
    const store = new SQLiteMessageStore(":memory:");
    const sessions = new SessionStore(":memory:", clock);
    const visible: VisibleEntry[] = [];
    const failures = new Set<string>();
    const notification = vi.fn(async (input: ClaudeChannelNotification) => {
      const messageId = input.params.meta.message;
      if (failures.delete(messageId)) throw new Error(`forced failure for ${messageId}`);
      visible.push({ id: messageId, content: input.params.content });
    });
    const server = { notification } as unknown as Server;
    const channel = new ClaudeChannelAdapter(server, {
      sessionId: CONTRACT_SESSION,
      protocolVersion: PROTOCOL_VERSION,
      ...(capabilities.activeDelivery ? { activationVerifiedAt: "2026-11-09T00:00:00.000Z" } : {}),
    });
    channel.observeInitialize({
      capabilities: {
        experimental: { "claude/channel": {}, "claude/channel/permission": {} },
      },
    });
    const adapter = new FakeHookContractAdapter(channel, visible);
    sessions.register(contractRegistration(CONTRACT_SESSION, capabilities), false);
    const dispatcher = new Dispatcher(
      store,
      sessions,
      new Map([[`${CONTRACT_PROJECT}/${CONTRACT_AGENT}`, adapter]]),
      clock,
    );

    const harness: Harness = {
      adapter,
      sessions,
      store,
      clock,
      visible,
      dispatcher,
      setState(state) {
        sessions.heartbeat(CONTRACT_PROJECT, CONTRACT_AGENT, CONTRACT_SESSION, state);
      },
      failNext(messageId) {
        failures.add(messageId);
      },
      close() {
        sessions.close();
        store.close();
      },
    };
    return harness;
  },
);
