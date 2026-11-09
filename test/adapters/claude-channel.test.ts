import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Notification, ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ClaudeChannelAdapter,
  createClaudeChannelServer,
  runClaudeAdapter,
} from "../../src/adapters/claude-channel.js";
import { frameMessage } from "../../src/adapters/reference.js";
import type { Message } from "../../src/domain/message.js";
import { PROTOCOL_VERSION } from "../../src/domain/session.js";

const message: Message = {
  id: "69d2065f-46a4-4b2f-9482-f9a64f349e26",
  project: "verdicta",
  from: "cto",
  to: "arch",
  text: "Review the channel protocol",
  expectsReply: false,
  idempotencyKey: "channel-message",
  threadId: "thread-channel",
  createdAt: "2026-11-09T00:00:00.000Z",
  deliveryState: "stored",
};

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function connectMockClaude(): Promise<{
  server: Server;
  client: Client;
  initialized: { capabilities: ServerCapabilities };
  channelNotifications: Notification[];
}> {
  const server = createClaudeChannelServer();
  const client = new Client({ name: "mock-claude", version: "0.0.0" }, { capabilities: {} });
  const channelNotifications: Notification[] = [];
  client.fallbackNotificationHandler = async (notification) => {
    channelNotifications.push({
      method: notification.method,
      ...(notification.params === undefined ? {} : { params: notification.params }),
    });
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  closers.push(
    () => client.close(),
    () => server.close(),
  );
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const capabilities = client.getServerCapabilities();
  if (!capabilities) throw new Error("mock initialize returned no capabilities");
  return { server, client, initialized: { capabilities }, channelNotifications };
}

function verifiedConfig(sessionId = "claude-session-1") {
  return {
    sessionId,
    protocolVersion: PROTOCOL_VERSION,
    activationVerifiedAt: "2026-11-09T00:00:00.000Z",
  };
}

describe("Claude channel protocol", () => {
  it("declares the required Claude channel capabilities", async () => {
    const { initialized } = await connectMockClaude();

    expect(initialized.capabilities.experimental).toEqual({
      "claude/channel": {},
      "claude/channel/permission": {},
    });
  });

  it("emits a provenance-preserving channel notification and returns only submitted", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const running = await runClaudeAdapter(verifiedConfig(), serverTransport);
    closers.push(() => running.server.close());
    const runningClient = new Client(
      { name: "mock-running-claude", version: "0.0.0" },
      { capabilities: {} },
    );
    const runningNotifications: Notification[] = [];
    runningClient.fallbackNotificationHandler = async (notification) => {
      runningNotifications.push({
        method: notification.method,
        ...(notification.params === undefined ? {} : { params: notification.params }),
      });
    };
    closers.push(() => runningClient.close());
    await runningClient.connect(clientTransport);
    running.adapter.observeHook("SessionStart", "claude-session-1");

    const receipt = await running.adapter.submit("claude-session-1", message);

    expect(receipt).toEqual({ state: "submitted" });
    expect(running.adapter.capabilities).toEqual({
      activeDelivery: true,
      stateReporting: true,
      clientIdempotency: true,
    });
    expect(runningNotifications).toHaveLength(1);
    expect(runningNotifications[0]).toEqual({
      method: "notifications/claude/channel",
      params: {
        content: frameMessage(message),
        meta: {
          project: "verdicta",
          from: "cto",
          message: message.id,
          thread: message.threadId,
        },
      },
    });
  });

  it.each([
    [
      "missing activation",
      { experimental: { "claude/channel": {}, "claude/channel/permission": {} } },
      false,
    ],
    ["missing channel", { experimental: { "claude/channel/permission": {} } }, true],
    ["missing permission", { experimental: { "claude/channel": {} } }, true],
  ])("fails closed with %s", async (_name, experimental, activation) => {
    const notification = vi.fn().mockResolvedValue(undefined);
    const server = { notification } as unknown as Server;
    const adapter = new ClaudeChannelAdapter(server, {
      sessionId: "claude-session-1",
      protocolVersion: PROTOCOL_VERSION,
      ...(activation ? { activationVerifiedAt: "2026-11-09T00:00:00.000Z" } : {}),
    });
    adapter.observeInitialize({ capabilities: { experimental } });
    adapter.observeHook("SessionStart", "claude-session-1");

    await expect(adapter.submit("claude-session-1", message)).rejects.toThrow(
      "active delivery is not activated",
    );
    expect(adapter.capabilities.activeDelivery).toBe(false);
    expect(notification).not.toHaveBeenCalled();
  });

  it("rejects a different session or protocol without injection", async () => {
    const notification = vi.fn().mockResolvedValue(undefined);
    const server = { notification } as unknown as Server;
    const wrongProtocol = new ClaudeChannelAdapter(server, {
      ...verifiedConfig(),
      protocolVersion: PROTOCOL_VERSION + 1,
    });
    wrongProtocol.observeInitialize({
      capabilities: {
        experimental: { "claude/channel": {}, "claude/channel/permission": {} },
      },
    });
    wrongProtocol.observeHook("SessionStart", "claude-session-1");

    await expect(wrongProtocol.submit("claude-session-1", message)).rejects.toThrow();
    expect(wrongProtocol.capabilities.activeDelivery).toBe(false);

    const wrongSession = new ClaudeChannelAdapter(server, verifiedConfig("other-session"));
    wrongSession.observeInitialize({
      capabilities: {
        experimental: { "claude/channel": {}, "claude/channel/permission": {} },
      },
    });
    wrongSession.observeHook("SessionStart", "claude-session-1");
    await expect(wrongSession.submit("claude-session-1", message)).rejects.toThrow(
      "session ID does not match",
    );
    expect(notification).not.toHaveBeenCalled();
  });

  it("deduplicates a retried notification by Synloq message ID", async () => {
    const { initialized } = await connectMockClaude();
    const notification = vi.fn().mockResolvedValue(undefined);
    const server = { notification } as unknown as Server;
    const adapter = new ClaudeChannelAdapter(server, verifiedConfig());
    adapter.observeInitialize(initialized);
    adapter.observeHook("SessionStart", "claude-session-1");

    const first = await adapter.submit("claude-session-1", message);
    adapter.observeHook("UserPromptSubmit", "claude-session-1");
    const retry = await adapter.submit("claude-session-1", message);

    expect(retry).toBe(first);
    expect(notification).toHaveBeenCalledTimes(1);
  });
});
