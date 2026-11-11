import { Readable, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { mapClaudeHook } from "../../src/adapters/claude-state.js";
import { frameMessage } from "../../src/adapters/reference.js";
import { runClaudeHook } from "../../src/cli/claude-hook.js";
import type { Message } from "../../src/domain/message.js";
import type { RelayHttpClient } from "../../src/transport/http-client.js";

const config = {
  project: "verdicta",
  agentId: "arch",
  sessionId: "claude-session-1",
};

const message: Message = {
  id: "69d2065f-46a4-4b2f-9482-f9a64f349e26",
  project: "verdicta",
  from: "cto",
  to: "arch",
  text: "Review the hook state",
  expectsReply: false,
  idempotencyKey: "hook-message",
  threadId: "thread-hook",
  createdAt: "2026-11-09T00:00:00.000Z",
  deliveryState: "submitted",
};

function fakeClient() {
  const heartbeat = vi.fn().mockResolvedValue({ session: { generation: 1 } });
  const receipt = vi.fn().mockResolvedValue(undefined);
  return {
    heartbeat,
    receipt,
    client: { heartbeat, receipt } as unknown as RelayHttpClient,
  };
}

async function invokeHook(
  client: RelayHttpClient,
  input: Record<string, unknown>,
  sessionId = config.sessionId,
): Promise<{ result: unknown; output: string }> {
  let output = "";
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      output += String(chunk);
      callback();
    },
  });
  const result = await runClaudeHook(
    client,
    { ...config, sessionId },
    { stdin: Readable.from([JSON.stringify(input)]), stdout },
  );
  return { result, output };
}

describe("Claude hook state mapping", () => {
  it.each([
    ["SessionStart", "idle"],
    ["UserPromptSubmit", "busy"],
    ["Stop", "idle"],
    ["StopFailure", "idle"],
    ["SessionEnd", "closed"],
    ["PreToolUse", "unknown"],
  ] as const)("maps %s to %s", (event, expected) => {
    expect(mapClaudeHook(event).state).toBe(expected);
  });

  it("heartbeats busy and posts delivered only from UserPromptSubmit", async () => {
    const { client, heartbeat, receipt } = fakeClient();
    const hook = {
      session_id: config.sessionId,
      hook_event_name: "UserPromptSubmit",
      prompt: frameMessage(message, 1),
    };

    const { result, output } = await invokeHook(client, hook);

    expect(heartbeat).toHaveBeenCalledWith({
      sessionId: config.sessionId,
      state: "busy",
    });
    expect(receipt).toHaveBeenCalledWith(
      message.id,
      {
        state: "delivered",
        clientMessageId: message.id,
        evidence: {
          sessionId: config.sessionId,
          generation: 1,
          project: message.project,
          from: message.from,
          messageId: message.id,
          threadId: message.threadId,
        },
      },
      { sessionId: config.sessionId, generation: 1 },
    );
    expect(result).toBeUndefined();
    expect(output).toBe("");
  });

  it("does not turn an envelope in another hook into delivered evidence", async () => {
    const { client, heartbeat, receipt } = fakeClient();

    await invokeHook(client, {
      session_id: config.sessionId,
      hook_event_name: "Stop",
      prompt: frameMessage(message),
    });

    expect(heartbeat).toHaveBeenCalledWith({
      sessionId: config.sessionId,
      state: "idle",
    });
    expect(receipt).not.toHaveBeenCalled();
  });

  it("heartbeats unknown and emits no permission decision or additional context", async () => {
    const { client, heartbeat, receipt } = fakeClient();

    const { result, output } = await invokeHook(client, {
      session_id: config.sessionId,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "echo unsafe-auto-approval" },
    });

    expect(heartbeat).toHaveBeenCalledWith({
      sessionId: config.sessionId,
      state: "unknown",
    });
    expect(receipt).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
    expect(output).toBe("");
  });

  it("rejects a hook for a different visible session before reporting", async () => {
    const { client, heartbeat, receipt } = fakeClient();

    await expect(
      invokeHook(client, {
        session_id: "other-claude-session",
        hook_event_name: "UserPromptSubmit",
        prompt: frameMessage(message),
      }),
    ).rejects.toThrow("session ID does not match");
    expect(heartbeat).not.toHaveBeenCalled();
    expect(receipt).not.toHaveBeenCalled();
  });

  it.each([
    ['<synloq message="not-a-uuid">not evidence</synloq>'],
    [`<synloq message="${message.id}">ID-only is not evidence</synloq>`],
    [`<synloq project="verdicta" from="cto" message="${message.id}">missing thread</synloq>`],
  ])("ignores an incomplete provenance envelope: %s", async (prompt) => {
    const { client, receipt } = fakeClient();

    const { output } = await invokeHook(client, {
      session_id: config.sessionId,
      hook_event_name: "UserPromptSubmit",
      prompt,
    });

    expect(receipt).not.toHaveBeenCalled();
    expect(output).toBe("");
  });
});
