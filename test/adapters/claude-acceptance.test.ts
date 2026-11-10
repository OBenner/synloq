import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { describe, expect, it, vi } from "vitest";
import { ClaudeChannelAdapter } from "../../src/adapters/claude-channel.js";
import type { Message } from "../../src/domain/message.js";
import { PROTOCOL_VERSION } from "../../src/domain/session.js";

const message: Message = {
  id: "69d2065f-46a4-4b2f-9482-f9a64f349e26",
  project: "verdicta",
  from: "arch",
  to: "cto",
  text: "Controlled acceptance probe",
  expectsReply: false,
  idempotencyKey: "claude-acceptance-1",
  threadId: "thread-claude-acceptance",
  createdAt: "2026-11-10T00:00:00.000Z",
  deliveryState: "submitted",
};

function channelCapabilities() {
  return {
    capabilities: {
      experimental: {
        "claude/channel": {},
        "claude/channel/permission": {},
      },
    },
  };
}

describe("Claude controlled acceptance", () => {
  it("allows exactly the configured message once without production verification", async () => {
    const notification = vi.fn().mockResolvedValue(undefined);
    const server = { notification } as unknown as Server;
    const adapter = new ClaudeChannelAdapter(server, {
      sessionId: "claude-visible-cto",
      protocolVersion: PROTOCOL_VERSION,
      acceptanceMessageId: message.id,
    });
    adapter.observeInitialize(channelCapabilities());

    expect(adapter.capabilities.activeDelivery).toBe(true);
    const receipt = await adapter.submit("claude-visible-cto", message);

    expect(receipt).toEqual({ state: "submitted" });
    expect(notification).toHaveBeenCalledTimes(1);
    expect(adapter.capabilities.activeDelivery).toBe(false);
    await expect(adapter.submit("claude-visible-cto", message)).resolves.toBe(receipt);
    expect(notification).toHaveBeenCalledTimes(1);
  });

  it("rejects every ordinary message before and after the acceptance probe", async () => {
    const notification = vi.fn().mockResolvedValue(undefined);
    const server = { notification } as unknown as Server;
    const adapter = new ClaudeChannelAdapter(server, {
      sessionId: "claude-visible-cto",
      protocolVersion: PROTOCOL_VERSION,
      acceptanceMessageId: message.id,
    });
    adapter.observeInitialize(channelCapabilities());
    const ordinary = {
      ...message,
      id: "f99b3f6d-e1a4-4d5f-9634-ee33c33efce8",
      idempotencyKey: "claude-ordinary-1",
    };

    await expect(adapter.submit("claude-visible-cto", ordinary)).rejects.toThrow(
      "active delivery is not activated",
    );
    expect(notification).not.toHaveBeenCalled();

    await adapter.submit("claude-visible-cto", message);
    await expect(adapter.submit("claude-visible-cto", ordinary)).rejects.toThrow(
      "active delivery is not activated",
    );
    expect(notification).toHaveBeenCalledTimes(1);
  });
});
