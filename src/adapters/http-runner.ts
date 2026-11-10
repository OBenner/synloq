import { SynloqError } from "../domain/errors.js";
import type { RelayHttpClient } from "../transport/http-client.js";
import type { DeliveryAdapter } from "./types.js";

const INITIAL_BACKOFF_MS = 200;
const MAX_BACKOFF_MS = 30_000;

export type AdapterPollResult = "inactive" | "empty" | "submitted" | "delivered" | "failed";

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

  constructor(
    private readonly relay: RelayHttpClient,
    private readonly adapter: DeliveryAdapter,
    private readonly sessionId: string,
    private readonly waitMs = 25_000,
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

    const { message } = await this.relay.nextDelivery({
      waitMs: this.waitMs,
      signal: this.abortController.signal,
    });
    if (!message) return "empty";

    try {
      const receipt = await this.adapter.submit(this.sessionId, message);
      if (receipt.state === "delivered") {
        await this.relay.receipt(message.id, receipt);
        return "delivered";
      }
      return "submitted";
    } catch (error) {
      const uncertain = error instanceof SynloqError && error.code === "DELIVERY_UNCERTAIN";
      await this.relay.deliveryFailure(message.id, {
        sessionId: this.sessionId,
        code: uncertain ? "DELIVERY_UNCERTAIN" : "RETRYABLE",
        clientIdempotency: this.adapter.capabilities.clientIdempotency,
      });
      return "failed";
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.abortController.abort();
    this.closePromise = this.task ?? Promise.resolve();
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
