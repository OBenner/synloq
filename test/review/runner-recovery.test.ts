import { describe, expect, it, vi } from "vitest";
import { HttpAdapterRunner } from "../../src/adapters/http-runner.js";
import type { DeliveryAdapter } from "../../src/adapters/types.js";
import { SynloqError } from "../../src/domain/errors.js";
import type { Message } from "../../src/domain/message.js";
import type { RelayHttpClient } from "../../src/transport/http-client.js";

const binding = { sessionId: "session-arch", generation: 1 };
const message: Message = {
  id: "69d2065f-46a4-4b2f-9482-f9a64f349e26",
  project: "verdicta",
  from: "cto",
  to: "arch",
  text: "Recover the outstanding delivery operation",
  expectsReply: false,
  idempotencyKey: "review-runner-recovery-1",
  threadId: "thread-review-runner-recovery",
  createdAt: "2026-11-10T00:00:00.000Z",
  deliveryState: "submitted",
};

function relayWith() {
  return {
    nextDelivery: vi.fn().mockResolvedValue({ message, ...binding }),
    authorizeDelivery: vi.fn().mockResolvedValue({ message }),
    receipt: vi.fn().mockResolvedValue({ message: { ...message, deliveryState: "delivered" } }),
    deliveryFailure: vi.fn().mockResolvedValue({ message }),
  } as unknown as RelayHttpClient;
}

function adapterWith(submit: DeliveryAdapter["submit"]): DeliveryAdapter {
  return {
    capabilities: { activeDelivery: true, stateReporting: true, clientIdempotency: true },
    state: vi.fn().mockResolvedValue("idle"),
    submit,
  };
}

describe("HTTP runner outstanding operation recovery", () => {
  it("retries a failed delivered receipt without reporting failure or resubmitting", async () => {
    const relay = relayWith();
    vi.mocked(relay.receipt).mockRejectedValueOnce(new Error("receipt response lost"));
    const adapter = adapterWith(vi.fn().mockResolvedValue({ state: "delivered" }));
    const runner = new HttpAdapterRunner(relay, adapter, binding, 0);

    await runner.runOnce().catch(() => undefined);
    await runner.runOnce();

    expect(relay.deliveryFailure).not.toHaveBeenCalled();
    expect(adapter.submit).toHaveBeenCalledTimes(1);
    expect(relay.nextDelivery).toHaveBeenCalledTimes(1);
    expect(relay.receipt).toHaveBeenCalledTimes(2);
  });

  it("retries a failed failure report before polling or submitting again", async () => {
    const relay = relayWith();
    vi.mocked(relay.deliveryFailure)
      .mockRejectedValueOnce(new Error("failure response lost"))
      .mockResolvedValueOnce({ message: { ...message, deliveryState: "stored" } });
    const adapter = adapterWith(
      vi.fn().mockRejectedValue(new SynloqError("INVALID_INPUT", "not transmitted")),
    );
    const runner = new HttpAdapterRunner(relay, adapter, binding, 0);

    await runner.runOnce().catch(() => undefined);
    await runner.runOnce();

    expect(relay.nextDelivery).toHaveBeenCalledTimes(1);
    expect(adapter.submit).toHaveBeenCalledTimes(1);
    expect(relay.deliveryFailure).toHaveBeenCalledTimes(2);
    expect(relay.receipt).not.toHaveBeenCalled();
  });

  it("bounds close when client submission never settles", async () => {
    const relay = relayWith();
    const adapter = adapterWith(vi.fn().mockImplementation(() => new Promise(() => {})));
    const runner = new HttpAdapterRunner(relay, adapter, binding, 0, 25);
    runner.start();
    await vi.waitFor(() => expect(adapter.submit).toHaveBeenCalledTimes(1), {
      timeout: 1_000,
      interval: 1,
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("close exceeded 200 ms")), 200);
    });
    try {
      await expect(Promise.race([runner.close(), deadline])).resolves.toBeUndefined();
    } finally {
      if (timer) clearTimeout(timer);
    }
    expect(relay.deliveryFailure).not.toHaveBeenCalled();
    expect(relay.receipt).not.toHaveBeenCalled();
  });
});
