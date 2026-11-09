import type { Clock } from "../adapters/types.js";
import { SynloqError } from "../domain/errors.js";
import type { Message, SendMessageInput } from "../domain/message.js";
import type { PauseScope, SQLiteMessageStore } from "../storage/message-store.js";

export interface ProtectionLimits {
  senderPerMinute: number;
  recipientPerMinute: number;
  maxPendingMessages: number;
  maxPendingBytes: number;
  maxThreadMessagesPerWindow: number;
  threadWindowMs: number;
}

interface TokenBucket {
  tokens: number;
  resetAt: number;
}

export const DEFAULT_LIMITS: ProtectionLimits = {
  senderPerMinute: 10,
  recipientPerMinute: 20,
  maxPendingMessages: 100,
  maxPendingBytes: 1024 * 1024,
  maxThreadMessagesPerWindow: 12,
  threadWindowMs: 2 * 60 * 1000,
};

export class ProtectionPolicy {
  constructor(
    private readonly store: SQLiteMessageStore,
    private readonly limits: ProtectionLimits = DEFAULT_LIMITS,
    private readonly buckets = new Map<string, TokenBucket>(),
    private readonly clock: Clock = { now: () => Date.now() },
  ) {}

  beforeSend(input: SendMessageInput): void {
    this.take(`sender:${input.project}:${input.from}`, this.limits.senderPerMinute);
    this.take(`recipient:${input.project}:${input.to}`, this.limits.recipientPerMinute);
    const usage = this.store.pendingUsage(input.project, input.to);
    if (
      usage.count >= this.limits.maxPendingMessages ||
      usage.bytes + Buffer.byteLength(input.text) > this.limits.maxPendingBytes
    ) {
      throw new SynloqError("QUEUE_FULL", "recipient queue limit reached");
    }
  }

  afterAccept(message: Message): void {
    const count = this.store.countThreadSince(
      message.threadId,
      new Date(this.clock.now() - this.limits.threadWindowMs).toISOString(),
    );
    if (count >= this.limits.maxThreadMessagesPerWindow) {
      this.pause(message.project, "thread", message.threadId);
    }
  }

  pause(project: string, scope: PauseScope, scopeId: string): void {
    this.store.pause(project, scope, scopeId, new Date(this.clock.now()).toISOString());
  }

  resume(project: string, scope: PauseScope, scopeId: string): void {
    this.store.resume(project, scope, scopeId);
  }

  isPaused(project: string, scope: PauseScope, scopeId: string): boolean {
    return this.store.isPaused(project, scope, scopeId);
  }

  private take(key: string, limit: number): void {
    const now = this.clock.now();
    let bucket = this.buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { tokens: limit, resetAt: now + 60_000 };
      this.buckets.set(key, bucket);
    }
    if (bucket.tokens <= 0) {
      throw new SynloqError("RATE_LIMITED", "message rate limit reached");
    }
    bucket.tokens -= 1;
  }
}
