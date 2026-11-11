import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpAdapterRunner } from "../../src/adapters/http-runner.js";
import type { DeliveryAdapter } from "../../src/adapters/types.js";
import { SynloqError } from "../../src/domain/errors.js";
import type { Message } from "../../src/domain/message.js";
import type { RelayHttpClient } from "../../src/transport/http-client.js";

const message: Message = {
  id: "69d2065f-46a4-4b2f-9482-f9a64f349e26",
  project: "verdicta",
  from: "cto",
  to: "arch",
  text: "Deliver over the HTTP adapter path",
  expectsReply: false,
  idempotencyKey: "http-runner-1",
  threadId: "thread-http-runner",
  createdAt: "2026-11-10T00:00:00.000Z",
  deliveryState: "submitted",
};

function adapterWith(submit: DeliveryAdapter["submit"], activeDelivery = true): DeliveryAdapter {
  return {
    capabilities: {
      activeDelivery,
      stateReporting: true,
      clientIdempotency: true,
    },
    state: vi.fn().mockResolvedValue("idle"),
    submit,
  };
}

const binding = { sessionId: "session-arch", generation: 1 };

function relayWith(messageValue: Message | null) {
  return {
    nextDelivery: vi.fn().mockResolvedValue({ message: messageValue, ...binding }),
    authorizeDelivery: vi.fn().mockResolvedValue({ message }),
    receipt: vi.fn().mockResolvedValue({ message }),
    deliveryFailure: vi.fn().mockResolvedValue({ message }),
  } as unknown as RelayHttpClient;
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe("HTTP adapter runner", () => {
  it("posts only delivered receipts and leaves submitted messages for client evidence", async () => {
    const relay = relayWith(message);
    const delivered = adapterWith(vi.fn().mockResolvedValue({ state: "delivered" }));
    const submitted = adapterWith(vi.fn().mockResolvedValue({ state: "submitted" }));

    await expect(new HttpAdapterRunner(relay, delivered, binding).runOnce()).resolves.toBe(
      "delivered",
    );
    expect(relay.receipt).toHaveBeenCalledWith(message.id, { state: "delivered" }, binding);

    vi.mocked(relay.receipt).mockClear();
    await expect(new HttpAdapterRunner(relay, submitted, binding).runOnce()).resolves.toBe(
      "submitted",
    );
    expect(relay.receipt).not.toHaveBeenCalled();
  });

  it("fails closed without polling when active delivery is unavailable", async () => {
    const relay = relayWith(message);
    const adapter = adapterWith(vi.fn(), false);
    const runner = new HttpAdapterRunner(relay, adapter, binding);

    await expect(runner.runOnce()).resolves.toBe("inactive");
    expect(relay.nextDelivery).not.toHaveBeenCalled();
    expect(adapter.submit).not.toHaveBeenCalled();
  });

  it("reports retryable and uncertain failures with runtime idempotency", async () => {
    const relay = relayWith(message);
    const retryable = adapterWith(
      vi.fn().mockRejectedValue(new SynloqError("INVALID_INPUT", "not transmitted")),
    );
    await expect(new HttpAdapterRunner(relay, retryable, binding).runOnce()).resolves.toBe(
      "failed",
    );
    expect(relay.deliveryFailure).toHaveBeenCalledWith(message.id, {
      ...binding,
      code: "RETRYABLE",
      clientIdempotency: true,
    });

    const uncertainAdapter = adapterWith(
      vi.fn().mockRejectedValue(new SynloqError("DELIVERY_UNCERTAIN", "unknown admission")),
    );
    uncertainAdapter.capabilities.clientIdempotency = false;
    await expect(new HttpAdapterRunner(relay, uncertainAdapter, binding).runOnce()).resolves.toBe(
      "failed",
    );
    expect(relay.deliveryFailure).toHaveBeenLastCalledWith(message.id, {
      ...binding,
      code: "DELIVERY_UNCERTAIN",
      clientIdempotency: false,
    });
  });

  it("aborts a pending long poll and stops during close", async () => {
    let observedSignal: AbortSignal | undefined;
    const relay = {
      nextDelivery: vi.fn((options: { signal?: AbortSignal }) => {
        observedSignal = options.signal;
        return new Promise((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      }),
    } as unknown as RelayHttpClient;
    const runner = new HttpAdapterRunner(relay, adapterWith(vi.fn()), binding, 25_000);
    closers.push(() => runner.close());
    runner.start();
    await vi.waitFor(() => expect(relay.nextDelivery).toHaveBeenCalled(), {
      timeout: 1_000,
      interval: 1,
    });

    await runner.close();
    expect(observedSignal?.aborted).toBe(true);
    expect(relay.nextDelivery).toHaveBeenCalledTimes(1);
  });

  it("releases a claimed message when authorization fails before submission", async () => {
    const relay = relayWith(message);
    vi.mocked(relay.authorizeDelivery).mockRejectedValue(
      new SynloqError("INVALID_INPUT", "visible session became busy"),
    );
    const adapter = adapterWith(vi.fn());
    const runner = new HttpAdapterRunner(relay, adapter, binding);

    await expect(runner.runOnce()).resolves.toBe("failed");
    expect(adapter.submit).not.toHaveBeenCalled();
    expect(relay.deliveryFailure).toHaveBeenCalledWith(message.id, {
      ...binding,
      code: "RETRYABLE",
      clientIdempotency: true,
    });
  });
});
