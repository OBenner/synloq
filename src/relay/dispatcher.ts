import type { Clock, DeliveryAdapter, DeliveryReceipt } from "../adapters/types.js";
import { SynloqError } from "../domain/errors.js";
import type { Message } from "../domain/message.js";
import type { SQLiteMessageStore } from "../storage/message-store.js";
import type { SessionStore } from "../storage/session-store.js";

const INITIAL_BACKOFF_MS = 200;
const MAX_BACKOFF_MS = 30_000;

interface Backoff {
  failures: number;
  retryAt: number;
}

export class Dispatcher {
  private readonly flights = new Map<string, Promise<void>>();
  private readonly backoffs = new Map<string, Backoff>();

  constructor(
    private readonly messages: SQLiteMessageStore,
    private readonly sessions: SessionStore,
    private readonly adapters: Map<string, DeliveryAdapter>,
    private readonly clock: Clock = { now: () => Date.now() },
  ) {}

  kick(project: string, agentId: string): Promise<void> {
    const key = `${project}/${agentId}`;
    const existing = this.flights.get(key);
    if (existing) return existing;

    let tracked: Promise<void>;
    tracked = Promise.resolve()
      .then(() => this.drain(project, agentId))
      .finally(() => {
        if (this.flights.get(key) === tracked) this.flights.delete(key);
      });
    this.flights.set(key, tracked);
    return tracked;
  }

  async runOnce(project: string, agentId: string): Promise<void> {
    await this.attempt(project, agentId);
  }

  private async drain(project: string, agentId: string): Promise<void> {
    while (await this.attempt(project, agentId)) {
      // A delivered receipt admits the next FIFO entry; every other outcome stops.
    }
  }

  private async attempt(project: string, agentId: string): Promise<boolean> {
    const key = `${project}/${agentId}`;
    if (
      this.messages.isPaused(project, "project", "") ||
      this.messages.isPaused(project, "participant", agentId) ||
      this.sessions.effectiveState(project, agentId) !== "idle"
    ) {
      return false;
    }

    const pending = this.messages.nextPending(project, agentId);
    if (!pending || this.messages.isPaused(project, "thread", pending.threadId)) return false;

    const backoff = this.backoffs.get(key);
    if (backoff && this.clock.now() < backoff.retryAt) return false;

    const adapter = this.adapters.get(key);
    const session = this.sessions.list(project).find((candidate) => candidate.agentId === agentId);
    if (
      !adapter ||
      !session ||
      !adapter.capabilities.activeDelivery ||
      !adapter.capabilities.stateReporting ||
      !session.capabilities.activeDelivery ||
      !session.capabilities.stateReporting
    ) {
      return false;
    }

    let receipt: DeliveryReceipt;
    try {
      receipt = await adapter.submit(session.sessionId, pending);
    } catch (error) {
      this.handleSubmissionError(error, project, agentId, pending, key, adapter);
      return false;
    }

    if (receipt.state === "submitted") {
      this.messages.setDeliveryState(pending.id, "submitted");
      this.backoffs.delete(key);
      return false;
    }

    this.messages.setDeliveryState(pending.id, "delivered");
    this.backoffs.delete(key);
    return true;
  }

  private handleSubmissionError(
    error: unknown,
    project: string,
    agentId: string,
    pending: Message,
    key: string,
    adapter: DeliveryAdapter,
  ): void {
    const session = this.sessions.list(project).find((candidate) => candidate.agentId === agentId);
    const uncertainWithoutIdempotency =
      error instanceof SynloqError &&
      error.code === "DELIVERY_UNCERTAIN" &&
      (!adapter.capabilities.clientIdempotency || !session?.capabilities.clientIdempotency);

    if (uncertainWithoutIdempotency) {
      this.messages.setDeliveryState(pending.id, "submitted");
      this.messages.pause(
        project,
        "participant",
        agentId,
        new Date(this.clock.now()).toISOString(),
      );
      this.backoffs.delete(key);
      return;
    }

    const failures = (this.backoffs.get(key)?.failures ?? 0) + 1;
    const delay = Math.min(MAX_BACKOFF_MS, INITIAL_BACKOFF_MS * 2 ** (failures - 1));
    this.backoffs.set(key, { failures, retryAt: this.clock.now() + delay });
  }
}
