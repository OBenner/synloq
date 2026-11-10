import { SynloqError } from "../domain/errors.js";
import type { SessionBinding } from "../domain/session.js";
import type { DeliveryFailureRequest, RelayHttpClient } from "../transport/http-client.js";
import type { DeliveryAdapter, DeliveryReceipt } from "./types.js";

const INITIAL_BACKOFF_MS = 200;
const MAX_BACKOFF_MS = 30_000;

export type AdapterPollResult = "inactive" | "empty" | "submitted" | "delivered" | "failed";

type OutstandingOperation =
  | { kind: "receipt"; messageId: string; receipt: DeliveryReceipt }
  | { kind: "failure"; messageId: string; input: DeliveryFailureRequest };

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
  private readonly abortController = new AbortController();
  private task: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private outstanding: OutstandingOperation | undefined;

  constructor(
    private readonly relay: RelayHttpClient,
    private readonly adapter: DeliveryAdapter,
    private readonly binding: SessionBinding,
    private readonly waitMs = 25_000,
    private readonly closeTimeoutMs = 5_000,
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
    if (this.outstanding) return this.completeOutstanding();

    const { message } = await this.relay.nextDelivery({
      ...this.binding,
      waitMs: this.waitMs,
      signal: this.abortController.signal,
    });
    if (!message) return "empty";

    await this.relay.authorizeDelivery(message.id, this.binding);
    if (this.abortController.signal.aborted) return "inactive";
    let receipt: DeliveryReceipt;
    try {
      receipt = await this.adapter.submit(this.binding.sessionId, message, {
        generation: this.binding.generation,
        signal: this.abortController.signal,
      });
    } catch (error) {
      if (this.abortController.signal.aborted) return "inactive";
      const uncertain = error instanceof SynloqError && error.code === "DELIVERY_UNCERTAIN";
      this.outstanding = {
        kind: "failure",
        messageId: message.id,
        input: {
          ...this.binding,
          code: uncertain ? "DELIVERY_UNCERTAIN" : "RETRYABLE",
          clientIdempotency: this.adapter.capabilities.clientIdempotency,
        },
      };
      return this.completeOutstanding();
    }

    if (this.abortController.signal.aborted) return "inactive";
    if (receipt.state === "delivered") {
      this.outstanding = { kind: "receipt", messageId: message.id, receipt };
      return this.completeOutstanding();
    }
    return "submitted";
  }

  private async completeOutstanding(): Promise<AdapterPollResult> {
    const operation = this.outstanding;
    if (!operation) return "empty";
    if (operation.kind === "receipt") {
      await this.relay.receipt(operation.messageId, operation.receipt, this.binding);
      this.outstanding = undefined;
      return "delivered";
    }
    await this.relay.deliveryFailure(operation.messageId, operation.input);
    this.outstanding = undefined;
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
      } catch {
        if (signal.aborted) break;
        failures += 1;
        const delay = Math.min(MAX_BACKOFF_MS, INITIAL_BACKOFF_MS * 2 ** Math.max(0, failures - 1));
        await abortableSleep(delay, signal);
      }
    }
  }
}
