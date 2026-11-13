import { describe, expect, it, vi } from "vitest";
import { OpenCodeAdapter, type OpenCodeApi } from "../../src/adapters/opencode.js";
import type { Message } from "../../src/domain/message.js";
import type { RelayHttpClient } from "../../src/transport/http-client.js";

const SESSION = "review-visible-opencode";
const message: Message = {
  id: "69d2065f-46a4-4b2f-9482-f9a64f349e26",
  project: "verdicta",
  from: "cto",
  to: "arch",
  text: "Abort this ambiguous OpenCode prompt",
  expectsReply: false,
  idempotencyKey: "review-opencode-abort",
  threadId: "thread-review-opencode-abort",
  createdAt: "2026-11-10T00:00:00.000Z",
  deliveryState: "submitted",
};

describe("OpenCode submission cancellation", () => {
  it("unblocks a never-settling prompt and preserves delivery uncertainty", async () => {
    const api: OpenCodeApi = {
      getSession: vi.fn(async () => ({ exists: true, busy: false })),
      admit: vi.fn().mockImplementation(() => new Promise(() => {})),
      subscribeEvents: vi.fn((signal?: AbortSignal) => {
        const stream = {
          async *[Symbol.asyncIterator]() {
            await new Promise<void>((resolve) => {
              if (signal?.aborted) {
                resolve();
                return;
              }
              signal?.addEventListener("abort", () => resolve(), { once: true });
            });
          },
        };
        return Promise.resolve(stream as AsyncIterable<unknown>);
      }),
    };
    const relay = {
      heartbeat: vi.fn().mockResolvedValue({}),
      closeSession: vi.fn().mockResolvedValue({}),
    } as unknown as RelayHttpClient;
    const adapter = new OpenCodeAdapter(api, relay, {
      project: "verdicta",
      agentId: "arch",
      sessionId: SESSION,
      heartbeatIntervalMs: 5,
    });
    adapter.start();
    await vi.waitFor(async () => expect(await adapter.state(SESSION)).toBe("idle"), {
      timeout: 1_000,
      interval: 1,
    });
    const controller = new AbortController();
    const submission = adapter.submit(SESSION, message, {
      generation: 1,
      signal: controller.signal,
    });
    controller.abort();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("prompt abort exceeded 200 ms")), 200);
    });
    try {
      await expect(Promise.race([submission, deadline])).rejects.toMatchObject({
        code: "DELIVERY_UNCERTAIN",
      });
      await expect(Promise.race([adapter.close(), deadline])).resolves.toBeUndefined();
    } finally {
      await adapter.close().catch(() => undefined);
      if (timer) clearTimeout(timer);
    }
  });
});
