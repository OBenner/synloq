import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexQueueNudger } from "../../src/relay/codex-nudger.js";
import { NudgeLedger, NUDGE_COOLDOWN_MS } from "../../src/storage/nudge-ledger.js";
import { SQLiteMessageStore } from "../../src/storage/message-store.js";
import type { QueueNudgeOptions, QueueResult } from "../../src/host/codex/queue.js";

const project = "fixture";
const agentId = "staff1";
const threadId = "11111111-1111-4111-8111-111111111111";
const queueId = "22222222-2222-4222-8222-222222222222";
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "synloq-nudger-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  let now = Date.parse("2026-11-16T00:00:00Z");
  const messages = new SQLiteMessageStore(join(dir, "messages.sqlite"), { now: () => now });
  cleanups.push(() => messages.close());
  const ledgerPath = join(dir, "nudges.sqlite");
  const logs: string[] = [];
  const eligible = vi.fn().mockResolvedValue(true);
  const queue = vi
    .fn<(options: QueueNudgeOptions) => Promise<QueueResult>>()
    .mockResolvedValue({ kind: "accepted", queueId });
  const config = {
    version: 1 as const,
    enabled: true as const,
    executable: process.execPath,
    cliVersion: "0.169.0" as const,
    bindings: [{ agentId, threadId }],
  };
  function watcher() {
    const ledger = new NudgeLedger(ledgerPath);
    const nudger = new CodexQueueNudger({
      project,
      messages,
      ledger,
      config,
      eligible,
      queue,
      now: () => now,
      diagnostic: (line) => logs.push(line),
    });
    cleanups.push(async () => {
      await nudger.stop();
      ledger.close();
    });
    return nudger;
  }
  function add(to = agentId, text = "PRIVATE TASK BODY", at = now) {
    return messages.create(
      { project, from: "dev", to, text, expectsReply: true, idempotencyKey: crypto.randomUUID() },
      crypto.randomUUID(),
      new Date(at).toISOString(),
      crypto.randomUUID(),
    ).message;
  }
  return {
    messages,
    logs,
    eligible,
    queue,
    config,
    watcher,
    add,
    ledgerPath,
    advance: () => {
      now += NUDGE_COOLDOWN_MS;
    },
  };
}

describe("durable relay-side Codex nudger", () => {
  it("keeps the role cooldown when an acknowledged head is replaced immediately", async () => {
    const f = fixture();
    const first = f.add();
    const w = f.watcher();
    await w.tick();
    f.messages.acknowledge(first.id, project, agentId);
    f.add();
    await w.tick();
    expect(f.queue).toHaveBeenCalledTimes(1);
    f.advance();
    await w.tick();
    expect(f.queue).toHaveBeenCalledTimes(2);
  });

  it("does not announce exhaustion when the fifth nudge is actually acknowledged", async () => {
    const f = fixture();
    const message = f.add();
    const w = f.watcher();
    for (let i = 0; i < 4; i++) {
      await w.tick();
      f.advance();
    }
    f.queue.mockImplementationOnce(async () => {
      f.messages.acknowledge(message.id, project, agentId);
      return { kind: "accepted", queueId };
    });
    await w.tick();
    expect(f.queue).toHaveBeenCalledTimes(5);
    expect(f.logs.some((line) => line.includes("undelivered after 5 nudges"))).toBe(false);
  });

  it("does not bypass an uncertain owner when paused mail exposes another head", async () => {
    const f = fixture();
    const first = f.add();
    const w = f.watcher();
    f.queue.mockResolvedValueOnce({ kind: "uncertain", code: "QUEUE_OUTPUT_MISMATCH" });
    await w.tick();
    f.advance();
    f.add();
    f.messages.pause(project, "thread", first.threadId, new Date().toISOString());
    await w.tick();
    expect(f.queue).toHaveBeenCalledTimes(1);
    // Only a real ack frees an uncertain head for the next message.
    f.messages.acknowledge(first.id, project, agentId);
    await w.tick();
    expect(f.queue).toHaveBeenCalledTimes(2);
  });

  it("does not steal a live/crashed reservation even after its message is acked", async () => {
    const f = fixture();
    const first = f.add();
    const ledger = new NudgeLedger(f.ledgerPath);
    ledger.reserve(project, agentId, first.id, threadId, 1, () => false);
    ledger.close();
    f.messages.acknowledge(first.id, project, agentId);
    f.advance();
    f.add();
    await f.watcher().tick();
    expect(f.queue).not.toHaveBeenCalled();
    expect(f.logs.join("\n")).toContain("blocked=reserved");
  });

  it("queues identifiers only and never changes delivery state; actual ack ends retries", async () => {
    const f = fixture();
    const message = f.add();
    const w = f.watcher();
    await w.tick();
    expect(f.queue).toHaveBeenCalledTimes(1);
    const reminder = f.queue.mock.calls[0]![0].message;
    expect(reminder).toContain(message.id);
    expect(reminder).toContain(message.threadId);
    expect(reminder).toContain("synloq_inbox");
    expect(reminder).not.toContain(message.text);
    expect(f.messages.getMessage(message.id, project)?.deliveryState).toBe("stored");
    f.messages.acknowledge(message.id, project, agentId);
    f.advance();
    await w.tick();
    expect(f.queue).toHaveBeenCalledTimes(1);
    expect(f.logs.join("\n")).toContain("nudge does not guarantee turn start");
    expect(f.logs.join("\n")).not.toContain(message.text);
  });

  it("enforces a durable role cooldown across restarts and head changes, then caps at five", async () => {
    const f = fixture();
    const message = f.add();
    let w = f.watcher();
    await w.tick();
    await w.tick();
    await w.stop();
    w = f.watcher();
    await w.tick();
    expect(f.queue).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 7; i++) {
      f.advance();
      await w.tick();
    }
    expect(f.queue).toHaveBeenCalledTimes(5);
    expect(f.logs.filter((line) => line.includes("undelivered after 5 nudges"))).toHaveLength(1);
    await w.stop();
    w = f.watcher();
    f.advance();
    await w.tick();
    expect(f.queue).toHaveBeenCalledTimes(5);
    f.messages.acknowledge(message.id, project, agentId);
    f.add();
    await w.tick();
    expect(f.queue).toHaveBeenCalledTimes(6);
  });

  it("does not reset the message budget when its binding changes", async () => {
    const f = fixture();
    f.add();
    const w = f.watcher();
    for (let i = 0; i < 5; i++) {
      await w.tick();
      f.advance();
    }
    await w.stop();
    f.config.bindings[0]!.threadId = crypto.randomUUID();
    await f.watcher().tick();
    expect(f.queue).toHaveBeenCalledTimes(5);
  });

  it("reserves atomically across two owners and never retries an orphan reservation", async () => {
    const f = fixture();
    const message = f.add();
    const ledger = new NudgeLedger(f.ledgerPath);
    expect(ledger.reserve(project, agentId, message.id, threadId, 1, () => false)).toBe(1);
    ledger.close();
    const a = f.watcher();
    const b = f.watcher();
    f.advance();
    await Promise.all([a.tick(), b.tick()]);
    expect(f.queue).not.toHaveBeenCalled();
  });

  it("single-flights concurrent ticks and owners while the CLI is running", async () => {
    const f = fixture();
    f.add();
    let complete!: (result: QueueResult) => void;
    f.queue.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const a = f.watcher();
    const b = f.watcher();
    const first = a.tick();
    await vi.waitFor(() => expect(f.queue).toHaveBeenCalledTimes(1));
    f.advance();
    await b.tick();
    const second = a.tick();
    expect(f.queue).toHaveBeenCalledTimes(1);
    complete({ kind: "accepted", queueId });
    await Promise.all([first, second]);
  });

  it.each(["uncertain", "rejected", "disabled"] as const)(
    "never blindly retries %s, including after restart",
    async (kind) => {
      const f = fixture();
      f.add();
      f.queue.mockResolvedValue({ kind, code: "FIXTURE_FAILURE" });
      const w = f.watcher();
      await w.tick();
      await w.stop();
      f.advance();
      await f.watcher().tick();
      expect(f.queue).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps an exhausted oldest message from triggering nudges for later mail", async () => {
    const f = fixture();
    f.add();
    f.advance();
    f.add();
    const w = f.watcher();
    for (let i = 0; i < 8; i++) {
      await w.tick();
      f.advance();
    }
    expect(f.queue).toHaveBeenCalledTimes(5);
  });

  it("honors project/recipient/thread pause, quarantine, submitted delivery and host ownership", async () => {
    const f = fixture();
    const message = f.add();
    const w = f.watcher();
    for (const [scope, scopeId] of [
      ["project", ""],
      ["participant", agentId],
      ["thread", message.threadId],
    ] as const) {
      f.messages.pause(project, scope, scopeId, new Date().toISOString());
      await w.tick();
      expect(f.queue).not.toHaveBeenCalled();
      f.messages.resume(project, scope, scopeId);
    }
    f.eligible.mockResolvedValue(false);
    await w.tick();
    expect(f.queue).not.toHaveBeenCalled();
    f.eligible.mockResolvedValue(true);
    f.messages.setDeliveryState(message.id, project, "submitted");
    await w.tick();
    expect(f.queue).not.toHaveBeenCalled();
    f.messages.setDeliveryState(message.id, project, "delivered");
    await w.tick();
    expect(f.queue).toHaveBeenCalledTimes(1); // delivered is still unread until ack
    f.advance();
    const quarantined = f.add();
    f.messages.acknowledge(message.id, project, agentId);
    f.messages.quarantineDelivery(quarantined.id, project, agentId, new Date().toISOString());
    await w.tick();
    expect(f.queue).toHaveBeenCalledTimes(1);
  });

  it("rechecks ack after version checking and honours cancellation during shutdown", async () => {
    const f = fixture();
    const message = f.add();
    const w = f.watcher();
    f.queue.mockImplementation(async (options) => {
      f.messages.acknowledge(message.id, project, agentId);
      expect(await options.beforeQueue!()).toBe(false);
      return { kind: "cancelled", code: "NO_LONGER_ELIGIBLE" };
    });
    await w.tick();
    await w.stop();
    f.advance();
    await w.tick();
    expect(f.queue).toHaveBeenCalledTimes(1);
  });
});
