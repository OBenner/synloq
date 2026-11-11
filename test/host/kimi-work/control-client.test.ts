import { describe, expect, it } from "vitest";
import { z, type ZodType } from "zod";
import {
  KimiWorkControlClient,
  type KimiWorkBinding,
} from "../../../src/host/kimi-work/control-client.js";

const binding: KimiWorkBinding = {
  workAgentId: "main",
  conversationKey: "agent:main:main:conversation:d7be2b2c-edfc-4fc7-a010-1e7af6465138",
  sessionKey: "agent:main:main",
  workspacePath: "I:\\git\\Synloq",
  kernelSessionId: "conv-587ed547d4b9851e059afe14",
};

class FakeRpc {
  readonly calls: Array<{ method: string; params: object; signal?: AbortSignal }> = [];

  constructor(private readonly respond: (method: string, params: object) => unknown) {}

  async request<T>(
    method: string,
    params: object,
    schema: ZodType<T>,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    this.calls.push({ method, params, ...(options.signal ? { signal: options.signal } : {}) });
    return schema.parse(this.respond(method, params));
  }
}

const metadata = {
  conversation: {
    conversationKey: binding.conversationKey,
    sessionKey: binding.sessionKey,
    kernelSessionId: binding.kernelSessionId,
    origin: "client",
    workspacePath: binding.workspacePath,
    title: "Any title may change",
  },
  hostRevision: 1,
};

describe("KimiWorkControlClient", () => {
  it("decodes metadata using the exact installed-host parameters", async () => {
    const rpc = new FakeRpc(() => metadata);
    const client = new KimiWorkControlClient(rpc);

    await expect(client.metadata(binding)).resolves.toEqual({
      conversationKey: binding.conversationKey,
      sessionKey: binding.sessionKey,
      kernelSessionId: binding.kernelSessionId,
      origin: "client",
      workspacePath: binding.workspacePath,
    });
    expect(rpc.calls).toEqual([
      {
        method: "conversations.getMetadata",
        params: { agentId: "main", key: binding.conversationKey },
      },
    ]);
  });

  it("accepts installed-host metadata diagnostics without returning them", async () => {
    const rpc = new FakeRpc(() => ({
      conversation: {
        ...metadata.conversation,
        agentId: "main",
        conversationId: "d7be2b2c-edfc-4fc7-a010-1e7af6465138",
        kernelType: "kimi-code-v2",
        kernelSessionDir: "C:\\runtime\\session",
        kernelRecordsPath: "C:\\runtime\\session\\wire.jsonl",
        traceId: "trace-id",
        workTag: "normal",
        promptLayout: { id: "default" },
        clientInstructions: "host instructions",
        titleStatus: "generated",
        titleGeneratedAt: "2026-11-11T10:54:49.615Z",
        firstUserText: "first message",
        createdAt: "2026-11-11T10:54:33.476Z",
        updatedAt: "2026-11-11T10:54:49.616Z",
        extra: { runtimePreferences: { modelAlias: "k3-agent" } },
      },
    }));
    const client = new KimiWorkControlClient(rpc);

    await expect(client.metadata(binding)).resolves.toEqual({
      conversationKey: binding.conversationKey,
      sessionKey: binding.sessionKey,
      kernelSessionId: binding.kernelSessionId,
      origin: "client",
      workspacePath: binding.workspacePath,
    });
  });

  it("decodes busy state using only the conversation key", async () => {
    const rpc = new FakeRpc(() => ({ conversationKey: binding.conversationKey, busy: true }));
    const client = new KimiWorkControlClient(rpc);

    await expect(client.busy(binding)).resolves.toBe(true);
    expect(rpc.calls).toEqual([
      {
        method: "conversations.getBusy",
        params: { conversationKey: binding.conversationKey },
      },
    ]);
  });

  it("concatenates text parts and ignores non-text history parts", async () => {
    const rpc = new FakeRpc(() => ({
      messages: [
        {
          id: "history-1",
          turnId: "turn-1",
          role: "user",
          status: "complete",
          parts: [
            { kind: "text", text: "first\n" },
            { kind: "tool", text: "not conversation text" },
            { kind: "text", text: "second" },
          ],
        },
      ],
    }));
    const client = new KimiWorkControlClient(rpc);

    await expect(client.messages(binding, 25)).resolves.toEqual([
      {
        id: "history-1",
        turnId: "turn-1",
        role: "user",
        status: "complete",
        text: "first\nsecond",
      },
    ]);
    expect(rpc.calls).toEqual([
      {
        method: "conversations.getMessages",
        params: { agentId: "main", conversationKey: binding.conversationKey, limit: 25 },
      },
    ]);
  });

  it("accepts installed-host history diagnostics and rich non-text parts", async () => {
    const rpc = new FakeRpc(() => ({
      agentId: "main",
      conversationKey: binding.conversationKey,
      hasMore: false,
      messages: [
        {
          id: "history-1",
          turnId: "turn-1",
          role: "user",
          canEdit: true,
          status: "complete",
          createdAt: "2026-11-11T10:54:33.476Z",
          updatedAt: "2026-11-11T10:54:49.616Z",
          parts: [
            { kind: "text", text: "visible" },
            { kind: "tool-call", toolCallId: "call-1", toolName: "tool", args: {} },
            { kind: "tool-result", toolCallId: "call-1", isError: false, output: {} },
          ],
        },
      ],
    }));
    const client = new KimiWorkControlClient(rpc);

    await expect(client.messages(binding)).resolves.toEqual([
      {
        id: "history-1",
        turnId: "turn-1",
        role: "user",
        status: "complete",
        text: "visible",
      },
    ]);
  });

  it("sends once and accepts only the exact bound conversation and kernel", async () => {
    const controller = new AbortController();
    const rpc = new FakeRpc(() => ({
      accepted: true,
      conversationKey: binding.conversationKey,
      kernelSessionId: binding.kernelSessionId,
      turnId: "work-turn-uuid",
    }));
    const client = new KimiWorkControlClient(rpc);

    await expect(client.send(binding, "visible text", controller.signal)).resolves.toEqual({
      accepted: true,
      conversationKey: binding.conversationKey,
      kernelSessionId: binding.kernelSessionId,
      turnId: "work-turn-uuid",
    });
    expect(rpc.calls).toEqual([
      {
        method: "conversations.send",
        params: { agentId: "main", conversationKey: binding.conversationKey, text: "visible text" },
        signal: controller.signal,
      },
    ]);
  });

  it.each([
    ["not accepted", { accepted: false }],
    [
      "wrong conversation",
      { conversationKey: "agent:main:main:conversation:02ffbece-ba58-4e17-8c52-acf9615c9ccb" },
    ],
    ["wrong kernel", { kernelSessionId: "conv-other" }],
    ["empty turn", { turnId: "" }],
  ])("rejects a malformed or mismatched send result: %s", async (_name, override) => {
    const rpc = new FakeRpc(() => ({
      accepted: true,
      conversationKey: binding.conversationKey,
      kernelSessionId: binding.kernelSessionId,
      turnId: "work-turn-uuid",
      ...override,
    }));
    const client = new KimiWorkControlClient(rpc);

    await expect(client.send(binding, "visible text")).rejects.toThrow(
      "Kimi Work send result does not match the binding",
    );
  });

  it("uses the default history limit and strict message decoding", async () => {
    const rpc = new FakeRpc(() => ({
      messages: [{ id: "history-1", role: "user", status: "complete", parts: [{ kind: "text" }] }],
    }));
    const client = new KimiWorkControlClient(rpc);

    await expect(client.messages(binding)).rejects.toThrow();
    expect(rpc.calls[0]).toMatchObject({
      method: "conversations.getMessages",
      params: { agentId: "main", conversationKey: binding.conversationKey, limit: 50 },
    });
  });
});
