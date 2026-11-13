import { SynloqError } from "../domain/errors.js";
import type { SessionBinding } from "../domain/session.js";
import type { DeliveryFailureRequest, RelayHttpClient } from "../transport/http-client.js";
import type { DeliveryAdapter, DeliveryReceipt } from "./types.js";

const INITIAL_BACKOFF_MS = 200;
const MAX_BACKOFF_MS = 30_000;

export type AdapterPollResult = "inactive" | "empty" | "submitted" | "delivered" | "failed";

export type OutstandingOperation =
  | { kind: "receipt"; messageId: string; receipt: DeliveryReceipt }
  | { kind: "failure"; messageId: string; input: DeliveryFailureRequest };

/**
 * Holds the in-flight receipt/failure across runner instances so a
 * stop/start recovery (stale generation) does not lose it.
 */
export class OutstandingTracker {
  private operation: OutstandingOperation | undefined;

  get(): OutstandingOperation | undefined {
    return this.operation;
  }

  set(operation: OutstandingOperation): void {
    this.operation = operation;
  }

  clear(): void {
    this.operation = undefined;
  }
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

export class HttpAdapterRunner {
  onUnauthorized: ((error: SynloqError) => void) | undefined;

  private readonly abortController = new AbortController();
  private task: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly relay: RelayHttpClient,
    private readonly adapter: DeliveryAdapter,
    private readonly binding: SessionBinding,
    private readonly waitMs = 25_000,
    private readonly closeTimeoutMs = 5_000,
    private readonly tracker: OutstandingTracker = new OutstandingTracker(),
  ) {}

  start(): void {
    if (this.task || this.abortController.signal.aborted) return;
    this.task = this.loop();
  }

  async runOnce(): Promise<AdapterPollResult> {
    if (
      this.abortController.signal.aborted ||
      !this.adapter.capabilities.activeDelivery ||
      !this.adapter.capabilities.stateReporting
    ) {
      return "inactive";
    }
    if (this.tracker.get()) return this.completeOutstanding();

    const claimed = await this.relay.nextDelivery({
      ...this.binding,
      waitMs: this.waitMs,
      signal: this.abortController.signal,
    });
    if (!claimed.message) return "empty";
    const { message } = claimed;

    try {
      await this.relay.authorizeDelivery(message.id, this.binding);
    } catch {
      if (this.abortController.signal.aborted) return "inactive";
      this.tracker.set({
        kind: "failure",
        messageId: message.id,
        input: {
          ...this.binding,
          code: "RETRYABLE",
          clientIdempotency: this.adapter.capabilities.clientIdempotency,
        },
      });
      return this.completeOutstanding();
    }
    if (this.abortController.signal.aborted) return "inactive";
    let receipt: DeliveryReceipt;
    try {
      receipt = await this.adapter.submit(this.binding.sessionId, message, {
        generation: this.binding.generation,
        signal: this.abortController.signal,
        ...(claimed.pendingAfter === undefined ? {} : { pendingAfter: claimed.pendingAfter }),
      });
    } catch (error) {
      if (this.abortController.signal.aborted) return "inactive";
      const uncertain = error instanceof SynloqError && error.code === "DELIVERY_UNCERTAIN";
      this.tracker.set({
        kind: "failure",
        messageId: message.id,
        input: {
          ...this.binding,
          code: uncertain ? "DELIVERY_UNCERTAIN" : "RETRYABLE",
          clientIdempotency: this.adapter.capabilities.clientIdempotency,
        },
      });
      return this.completeOutstanding();
    }

    if (this.abortController.signal.aborted) return "inactive";
    if (receipt.state === "delivered") {
      this.tracker.set({ kind: "receipt", messageId: message.id, receipt });
      return this.completeOutstanding();
    }
    return "submitted";
  }

  private async completeOutstanding(): Promise<AdapterPollResult> {
    const operation = this.tracker.get();
    if (!operation) return "empty";
    if (operation.kind === "receipt") {
      await this.relay.receipt(operation.messageId, operation.receipt, this.binding);
      this.tracker.clear();
      return "delivered";
    }
    await this.relay.deliveryFailure(operation.messageId, {
      ...operation.input,
      ...this.binding,
    });
    this.tracker.clear();
    return "failed";
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.abortController.abort();
    const task = this.task;
    if (!task) {
      this.closePromise = Promise.resolve();
      return this.closePromise;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.closeTimeoutMs);
    });
    this.closePromise = Promise.race([task, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    return this.closePromise;
  }

  private async loop(): Promise<void> {
    let failures = 0;
    const { signal } = this.abortController;
    while (!signal.aborted) {
      try {
        const result = await this.runOnce();
        if (result === "failed") {
          failures += 1;
        } else {
          failures = 0;
        }
        if (result === "failed" || result === "inactive") {
          const delay = Math.min(
            MAX_BACKOFF_MS,
            INITIAL_BACKOFF_MS * 2 ** Math.max(0, failures - 1),
          );
          await abortableSleep(delay, signal);
        }
      } catch (error) {
        if (signal.aborted) break;
        if (error instanceof SynloqError && error.code === "UNAUTHORIZED") {
          this.abortController.abort();
          this.onUnauthorized?.(error);
          break;
        }
        failures += 1;
        const delay = Math.min(MAX_BACKOFF_MS, INITIAL_BACKOFF_MS * 2 ** Math.max(0, failures - 1));
        await abortableSleep(delay, signal);
      }
    }
  }
}
