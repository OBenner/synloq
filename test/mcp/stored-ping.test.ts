import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Clock } from "../../src/adapters/types.js";
import type { Participant } from "../../src/domain/message.js";
import { PROTOCOL_VERSION } from "../../src/domain/session.js";
import { createStoredPingWatcher } from "../../src/mcp/stored-ping.js";
import { SQLiteMessageStore } from "../../src/storage/message-store.js";
import { SessionStore } from "../../src/storage/session-store.js";

const PROJECT = "stored-ping";
const participants: Participant[] = [
  { project: PROJECT, agentId: "cto", title: "CTO", role: "coordination" },
  { project: PROJECT, agentId: "arch", title: "Architect", role: "review" },
];

let now = Date.parse("2026-11-15T12:00:00.000Z");
const clock = { now: () => now };

let directory: string;
let messages: SQLiteMessageStore;
let sessions: SessionStore;
const directories: string[] = [];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "synloq-stored-ping-"));
  directories.push(directory);
  messages = new SQLiteMessageStore(join(directory, "relay.sqlite"));
  sessions = new SessionStore(join(directory, "relay.sqlite"), clock);
});

afterEach(async () => {
  sessions.close();
  messages.close();
  await Promise.all(
    directories.splice(0).map((entry) => rm(entry, { recursive: true, force: true })),
  );
});

function register(agentId: string, state: "idle" | "busy"): void {
  sessions.register(
    {
      project: PROJECT,
      agentId,
      sessionId: `session-${agentId}`,
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { activeDelivery: true, stateReporting: true, clientIdempotency: true },
    },
    false,
  );
  sessions.heartbeat(PROJECT, agentId, `session-${agentId}`, state);
}

function storeOld(agentId: string, ageMs: number, key: string): void {
  messages.create(
    {
      project: PROJECT,
      from: "arch",
      to: agentId,
      text: "queued notice",
      expectsReply: false,
      idempotencyKey: `test-${key}`,
    },
    `11111111-1111-4111-8111-${key}`,
    new Date(now - ageMs).toISOString(),
    `22222222-2222-4222-8222-${key}`,
  );
}

function makeWatcher(push: (text: string) => Promise<boolean>, extra: { repeatMs?: number } = {}) {
  const diagnostics = { write: vi.fn() };
  const watcher = createStoredPingWatcher({
    project: PROJECT,
    agentId: "cto",
    participants,
    databasePath: join(directory, "relay.sqlite"),
    diagnostics,
    push,
    clock,
    ...(extra.repeatMs === undefined ? {} : { repeatMs: extra.repeatMs }),
  });
  return { watcher, diagnostics };
}

describe("createStoredPingWatcher (#45)", () => {
  it("pings a live idle chat with stale stored mail, content-free text", async () => {
    register("cto", "idle");
    storeOld("cto", 40 * 60_000, "000000000001");
    const push = vi.fn(async (_text: string) => true);
    const { watcher, diagnostics } = makeWatcher(push);
    await watcher.check();
    expect(push).toHaveBeenCalledTimes(1);
    const text = push.mock.calls[0]![0];
    expect(text).toContain("1 incoming");
    expect(text).toContain("synloq_inbox");
    expect(text).not.toContain("queued notice");
    expect(diagnostics.write).toHaveBeenCalledWith(expect.stringContaining("nudged"));
  });

  it("stays silent for a busy chat (mid-turn is never nudged)", async () => {
    register("cto", "busy");
    storeOld("cto", 40 * 60_000, "000000000002");
    const push = vi.fn(async () => true);
    const { watcher } = makeWatcher(push);
    await watcher.check();
    expect(push).not.toHaveBeenCalled();
  });

  it("stays silent for a dead session and for fresh mail", async () => {
    register("cto", "idle");
    storeOld("cto", 40 * 60_000, "000000000003");
    now += 10 * 60_000; // lease expires → dead channel
    const push = vi.fn(async () => true);
    const { watcher } = makeWatcher(push);
    await watcher.check();
    expect(push).not.toHaveBeenCalled();
    // Channel back, but the backlog was read and only fresh mail remains.
    sessions.heartbeat(PROJECT, "cto", "session-cto", "idle");
    const pending = messages.nextPending(PROJECT, "cto");
    if (pending) messages.acknowledge(pending.id, PROJECT, "cto");
    storeOld("cto", 60_000, "000000000004");
    await watcher.check();
    expect(push).not.toHaveBeenCalled();
  });

  it("throttles: one ping per backlog epoch, re-ping after repeatMs, new epoch re-pings", async () => {
    register("cto", "idle");
    storeOld("cto", 40 * 60_000, "000000000005");
    const push = vi.fn(async () => true);
    const { watcher } = makeWatcher(push, { repeatMs: 30 * 60_000 });
    await watcher.check();
    await watcher.check();
    expect(push).toHaveBeenCalledTimes(1);
    now += 29 * 60_000;
    sessions.heartbeat(PROJECT, "cto", "session-cto", "idle"); // keep the lease alive
    await watcher.check();
    expect(push).toHaveBeenCalledTimes(1);
    now += 2 * 60_000; // 31 minutes later the ignored backlog is re-pinged
    sessions.heartbeat(PROJECT, "cto", "session-cto", "idle");
    await watcher.check();
    expect(push).toHaveBeenCalledTimes(2);
    // A newer oldest message (old one read, new one aged) starts a new epoch.
    const pending = messages.nextPending(PROJECT, "cto");
    if (pending) messages.acknowledge(pending.id, PROJECT, "cto");
    storeOld("cto", 40 * 60_000, "000000000006");
    sessions.heartbeat(PROJECT, "cto", "session-cto", "idle");
    await watcher.check();
    expect(push).toHaveBeenCalledTimes(3);
  });

  it("does not record a ping when the push refuses, and retries next tick", async () => {
    register("cto", "idle");
    storeOld("cto", 40 * 60_000, "000000000007");
    const push = vi.fn(async () => false);
    const { watcher, diagnostics } = makeWatcher(push);
    await watcher.check();
    await watcher.check();
    expect(push).toHaveBeenCalledTimes(2);
    expect(diagnostics.write).toHaveBeenCalledWith(expect.stringContaining("not pushable"));
  });

  it("swallows a throwing push into a diagnostic line", async () => {
    register("cto", "idle");
    storeOld("cto", 40 * 60_000, "000000000008");
    const push = vi.fn(async () => {
      throw new Error("control socket gone");
    });
    const { watcher, diagnostics } = makeWatcher(push);
    await expect(watcher.check()).resolves.toBeUndefined();
    expect(diagnostics.write).toHaveBeenCalledWith(
      expect.stringContaining("stored-ping check failed"),
    );
  });

  it("stays silent for a paused participant", async () => {
    register("cto", "idle");
    storeOld("cto", 60 * 60_000, "000000000009");
    messages.pause(PROJECT, "participant", "cto", new Date(now).toISOString());
    const push = vi.fn(async () => true);
    const { watcher } = makeWatcher(push);
    await watcher.check();
    expect(push).not.toHaveBeenCalled();
  });

  it("never pings another role", async () => {
    register("arch", "idle");
    storeOld("arch", 40 * 60_000, "00000000000a");
    const push = vi.fn(async () => true);
    const { watcher } = makeWatcher(push); // watcher belongs to cto
    await watcher.check();
    expect(push).not.toHaveBeenCalled();
  });
});
