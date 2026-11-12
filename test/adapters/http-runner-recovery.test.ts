import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpAdapterRunner, OutstandingTracker } from "../../src/adapters/http-runner.js";
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
  idempotencyKey: "http-runner-recovery-1",
  threadId: "thread-http-runner-recovery",
  createdAt: "2026-11-10T00:00:00.000Z",
  deliveryState: "submitted",
};

function adapterWith(submit: DeliveryAdapter["submit"]): DeliveryAdapter {
  return {
    capabilities: { activeDelivery: true, stateReporting: true, clientIdempotency: true },
    state: vi.fn().mockResolvedValue("idle"),
    submit,
  };
}

function relayWith(
  messageValue: Message | null,
  binding: { sessionId: string; generation: number },
) {
  return {
    nextDelivery: vi.fn().mockResolvedValue({ message: messageValue, ...binding }),
    authorizeDelivery: vi.fn().mockResolvedValue({ message }),
    receipt: vi.fn().mockResolvedValue({ message }),
    deliveryFailure: vi.fn().mockResolvedValue({ message }),
  } as unknown as RelayHttpClient;
}

const staleBinding = { sessionId: "session-arch", generation: 1 };
const freshBinding = { sessionId: "session-arch", generation: 2 };

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe("HTTP adapter runner recovery", () => {
  it("preserves an outstanding receipt across a stop/start recovery cycle", async () => {
    const tracker = new OutstandingTracker();
    const staleRelay = relayWith(message, staleBinding);
    vi.mocked(staleRelay.receipt).mockRejectedValue(
      new SynloqError("UNAUTHORIZED", "session generation is stale"),
    );
    const delivered = adapterWith(vi.fn().mockResolvedValue({ state: "delivered" }));
    const first = new HttpAdapterRunner(staleRelay, delivered, staleBinding, 100, 5_000, tracker);
    closers.push(() => first.close());
    const onUnauthorized = vi.fn();
    first.onUnauthorized = onUnauthorized;

    first.start();
    await vi.waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1), {
      timeout: 1_000,
      interval: 1,
    });
    await first.close();

    // The recovered runner owns a fresh binding and must retry the outstanding
    // receipt before polling for new work. nextDelivery stays pending until the
    // runner closes so the poll loop does not spin on an instant mock.
    const freshRelay = relayWith(null, freshBinding);
    vi.mocked(freshRelay.nextDelivery).mockImplementation(
      (input: { signal?: AbortSignal }) =>
        new Promise((resolve) => {
          const empty = { message: null, ...freshBinding };
          const signal = input.signal;
          if (!signal || signal.aborted) {
            resolve(empty);
            return;
          }
          signal.addEventListener("abort", () => resolve(empty), { once: true });
        }),
    );
    const second = new HttpAdapterRunner(
      freshRelay,
      adapterWith(vi.fn()),
      freshBinding,
      100,
      5_000,
      tracker,
    );
    closers.push(() => second.close());
    second.start();

    await vi.waitFor(
      () =>
        expect(freshRelay.receipt).toHaveBeenCalledWith(
          message.id,
          { state: "delivered" },
          freshBinding,
        ),
      { timeout: 1_000, interval: 1 },
    );
    expect(tracker.get()).toBeUndefined();
    await vi.waitFor(() => expect(freshRelay.nextDelivery).toHaveBeenCalled(), {
      timeout: 1_000,
      interval: 1,
    });
  });

  it("keeps an injected tracker optional for existing call sites", async () => {
    const relay = relayWith(message, staleBinding);
    const delivered = adapterWith(vi.fn().mockResolvedValue({ state: "delivered" }));
    await expect(new HttpAdapterRunner(relay, delivered, staleBinding).runOnce()).resolves.toBe(
      "delivered",
    );
    expect(relay.receipt).toHaveBeenCalledWith(message.id, { state: "delivered" }, staleBinding);
  });
});
