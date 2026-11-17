import { randomUUID } from "node:crypto";
import type { Message } from "../domain/message.js";
import type { SecurityAuditLog } from "./audit-log.js";

export interface WebhookEvent {
  version: 1;
  event: "stored_pending";
  project: string;
  agentId: string;
  messageId: string;
  threadId: string;
  sentAt: string;
  relayInstance: string;
}

export interface WebhookSnapshot {
  relayInstance: string;
  observedAt: string;
  attempted: number;
  failed: number;
  dropped: number;
  queued: number;
  active: boolean;
  stopped: boolean;
}

interface Options {
  project: string;
  audit: SecurityAuditLog;
  send(event: WebhookEvent, signal: AbortSignal, timeoutMs: number): Promise<string>;
  now?: () => number;
  wallNow?: () => number;
}

const EPOCH_MS = 5 * 60_000;
const MAX_QUEUE = 256;
const MAX_EPOCHS = 1024;
const DEADLINE_MS = 5000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const increment = (n: number) => Math.min(Number.MAX_SAFE_INTEGER, n + 1);

/** One attempt per reserved event, including ambiguous failures. Never retries. */
export class WebhookNudger {
  private readonly instance = randomUUID();
  private readonly epochs = new Map<string, number>();
  private readonly queue: Array<{ event: WebhookEvent; expires: number }> = [];
  private readonly now: () => number;
  private readonly wallNow: () => number;
  private admissions: number[] = [];
  private lastAdmission = -Infinity;
  private attempts: number[] = [];
  private scheduled: ReturnType<typeof setTimeout> | undefined;
  private active: Promise<void> | undefined;
  private controller: AbortController | undefined;
  private stopped = false;
  private attempted = 0;
  private failed = 0;
  private dropped = 0;

  constructor(private readonly options: Options) {
    this.now = options.now ?? (() => performance.now());
    this.wallNow = options.wallNow ?? (() => Date.now());
  }

  created(message: Message): void {
    if (this.stopped || message.project !== this.options.project) return;
    if (
      !UUID.test(message.id) ||
      !UUID.test(message.threadId) ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(message.to)
    )
      return;
    const now = this.now();
    for (const [key, reserved] of this.epochs)
      if (now - reserved >= EPOCH_MS) this.epochs.delete(key);
    if (this.epochs.has(message.to)) return;
    if (this.epochs.size >= MAX_EPOCHS) {
      this.dropped = increment(this.dropped);
      return;
    }
    // Reserve even if the global cap drops this event. No repeated pressure from
    // the same pending epoch; ack-all permits a new epoch, still globally capped.
    this.epochs.set(message.to, now);
    this.admissions = this.admissions.filter((at) => now - at < 60_000);
    if (
      now - this.lastAdmission < 1000 ||
      this.admissions.length >= 30 ||
      this.queue.length >= MAX_QUEUE
    ) {
      this.dropped = increment(this.dropped);
      return;
    }
    this.lastAdmission = now;
    this.admissions.push(now);
    this.queue.push({
      expires: now + DEADLINE_MS,
      event: {
        version: 1,
        event: "stored_pending",
        project: this.options.project,
        agentId: message.to,
        messageId: message.id,
        threadId: message.threadId,
        relayInstance: this.instance,
        sentAt: new Date(this.wallNow()).toISOString(),
      },
    });
    this.schedule();
  }

  backlogEmpty(project: string, agentId: string): void {
    if (project === this.options.project) this.epochs.delete(agentId);
  }

  snapshot(): WebhookSnapshot {
    return {
      relayInstance: this.instance,
      observedAt: new Date(this.wallNow()).toISOString(),
      attempted: this.attempted,
      failed: this.failed,
      dropped: this.dropped,
      queued: this.queue.length,
      active: this.active !== undefined,
      stopped: this.stopped,
    };
  }

  private schedule(): void {
    if (this.stopped || this.active || this.scheduled || this.queue.length === 0) return;
    this.scheduled = setTimeout(() => {
      this.scheduled = undefined;
      this.active = this.runOne().finally(() => {
        this.active = undefined;
        this.schedule();
      });
    }, 0);
  }

  private async runOne(): Promise<void> {
    const entry = this.queue.shift();
    if (!entry || this.stopped) return;
    const remaining = entry.expires - this.now();
    if (remaining <= 0) {
      this.dropped = increment(this.dropped);
      return;
    }
    const now = this.now();
    this.attempts = this.attempts.filter((at) => now - at < 60_000);
    if (this.attempts.length >= 30 || now - (this.attempts.at(-1) ?? -Infinity) < 1000) {
      this.dropped = increment(this.dropped);
      return;
    }
    this.attempts.push(now);
    this.controller = new AbortController();
    this.attempted = increment(this.attempted);
    let outcome: string;
    try {
      outcome = await this.options.send(
        entry.event,
        this.controller.signal,
        Math.min(1000, Math.ceil(remaining)),
      );
    } catch {
      outcome = "NETWORK_ERROR";
    }
    this.controller = undefined;
    // Only our finite outcome vocabulary reaches audit, never thrown errors,
    // arbitrary receiver data, config URL or message text.
    if (!/^(HTTP_[1-5][0-9]{2}|TIMEOUT|NETWORK_ERROR|ABORTED)$/.test(outcome))
      outcome = "NETWORK_ERROR";
    const success = /^HTTP_2/.test(outcome);
    if (!success) this.failed = increment(this.failed);
    try {
      this.options.audit.record({
        at: new Date(this.wallNow()).toISOString(),
        project: this.options.project,
        agentId: entry.event.agentId,
        action: "webhook",
        decision: success ? "accept" : "degraded",
        reasonCode: outcome,
        detail: "webhook attempt completed; outcome is not message delivery",
      });
    } catch {
      /* Observability must not break the relay, even if the audit sink fails. */
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.scheduled) clearTimeout(this.scheduled);
    this.scheduled = undefined;
    this.queue.length = 0;
    this.epochs.clear();
    this.controller?.abort();
    await this.active;
  }
}
