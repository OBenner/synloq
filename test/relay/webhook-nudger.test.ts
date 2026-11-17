import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../../src/domain/message.js";
import { WebhookNudger, type WebhookEvent } from "../../src/relay/webhook-nudger.js";

const workers: WebhookNudger[] = [];
afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.stop();
  vi.useRealTimers();
});
function message(to = "arch"): Message {
  return {
    id: randomUUID(),
    threadId: randomUUID(),
    project: "test",
    from: "cto",
    to,
    text: "NEVER EXPORT THIS",
    expectsReply: true,
    idempotencyKey: "private-key",
    createdAt: new Date().toISOString(),
    deliveryState: "stored",
  };
}
function fixture() {
  vi.useFakeTimers();
  let now = 0;
  const send = vi.fn(
    async (_event: WebhookEvent, _signal: AbortSignal, _timeout: number) => "HTTP_500",
  );
  const audit = { record: vi.fn() };
  const worker = new WebhookNudger({
    project: "test",
    now: () => now,
    wallNow: () => Date.UTC(2026, 10, 17) + now,
    send,
    audit,
  });
  workers.push(worker);
  return {
    worker,
    send,
    audit,
    advance: async (ms: number) => {
      now += ms;
      await vi.advanceTimersByTimeAsync(ms);
    },
  };
}
describe("webhook epochs and bounded at-most-once worker", () => {
  it("reserves before IO, emits a strict identifier payload, never retries 500 or timeout", async () => {
    const f = fixture();
    const msg = message();
    f.worker.created(msg);
    f.worker.created(message());
    await f.advance(0);
    expect(f.send).toHaveBeenCalledTimes(1);
    const payload = f.send.mock.calls[0]![0];
    expect(Object.keys(payload).sort()).toEqual(
      [
        "agentId",
        "event",
        "messageId",
        "project",
        "relayInstance",
        "sentAt",
        "threadId",
        "version",
      ].sort(),
    );
    expect(payload).toMatchObject({
      version: 1,
      event: "stored_pending",
      project: "test",
      agentId: "arch",
      messageId: msg.id,
      threadId: msg.threadId,
    });
    expect(JSON.stringify(payload)).not.toContain(msg.text);
    await f.advance(300_000);
    expect(f.send).toHaveBeenCalledTimes(1); // No periodic replay/backfill.
    f.send.mockResolvedValue("TIMEOUT");
    f.worker.created(message());
    await f.advance(0);
    await f.advance(10_000);
    expect(f.send).toHaveBeenCalledTimes(2);
  });
  it("resets only on actual empty backlog and preserves project scope", async () => {
    const f = fixture();
    f.worker.created(message());
    await f.advance(1000);
    f.worker.backlogEmpty("other", "arch");
    f.worker.created(message());
    await f.advance(1000);
    expect(f.send).toHaveBeenCalledTimes(1);
    f.worker.backlogEmpty("test", "arch");
    f.worker.created(message());
    await f.advance(0);
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.send.mock.calls[1]![0].relayInstance).toBe(f.send.mock.calls[0]![0].relayInstance);
  });
  it("drops new events under rate pressure, bounds the counter and emits no per-drop audit", async () => {
    const f = fixture();
    f.worker.created(message());
    await f.advance(0);
    for (let i = 0; i < 500; i++) f.worker.created(message(`role-${i}`));
    await f.advance(0);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.worker.snapshot().dropped).toBe(500);
    expect(f.audit.record).toHaveBeenCalledTimes(1);
    await f.advance(1000);
    f.worker.created(message("role-0"));
    await f.advance(0);
    expect(f.send).toHaveBeenCalledTimes(1); // Drop reserves epoch too.
  });
  it("enforces rolling 30/min in addition to 1/sec", async () => {
    const f = fixture();
    for (let i = 0; i < 35; i++) {
      f.worker.created(message(`role-${i}`));
      await f.advance(1000);
    }
    expect(f.send).toHaveBeenCalledTimes(30);
    expect(f.worker.snapshot().dropped).toBe(5);
  });
  it("does not let audit failure leak into message handling; stop rejects queued work", async () => {
    const f = fixture();
    f.audit.record.mockImplementation(() => {
      throw new Error("secret");
    });
    f.worker.created(message());
    await f.worker.stop();
    await f.advance(0);
    expect(f.send).not.toHaveBeenCalled();
    f.worker.created(message("dev"));
    await f.advance(1000);
    expect(f.send).not.toHaveBeenCalled();
  });
  it("guards a failing audit sink after an actual attempt", async () => {
    const f = fixture();
    f.audit.record.mockImplementation(() => {
      throw new Error("private sink path");
    });
    f.worker.created(message());
    await f.advance(0);
    expect(f.worker.snapshot()).toMatchObject({ attempted: 1, failed: 1 });
    await f.advance(300_000);
    f.worker.created(message());
    await f.advance(0);
    expect(f.send).toHaveBeenCalledTimes(2);
  });
  it("expires queued work instead of sending stale events or scheduling retries", async () => {
    const f = fixture();
    f.worker.created(message());
    await f.advance(6000);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.worker.snapshot().dropped).toBe(1);
  });
  it("keeps one in-flight request and aborts it on close", async () => {
    const f = fixture();
    f.send.mockImplementation(
      (_event, signal) =>
        new Promise((resolve) =>
          signal.addEventListener("abort", () => resolve("ABORTED"), { once: true }),
        ),
    );
    f.worker.created(message());
    await f.advance(0);
    await f.advance(1000);
    f.worker.created(message("dev"));
    await f.advance(0);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.worker.snapshot().queued).toBe(1);
    await f.worker.stop();
    expect(f.worker.snapshot()).toMatchObject({ stopped: true, queued: 0, active: false });
  });
  it("keeps terminal audit bounded despite repeated ack-all/new epochs", async () => {
    const f = fixture();
    for (let i = 0; i < 200; i++) {
      f.worker.backlogEmpty("test", "arch");
      f.worker.created(message());
      await f.advance(100);
    }
    expect(f.send.mock.calls.length).toBeLessThanOrEqual(20);
    expect(f.audit.record.mock.calls.length).toBe(f.send.mock.calls.length);
    expect(f.worker.snapshot().dropped).toBeGreaterThan(0);
  });
});
