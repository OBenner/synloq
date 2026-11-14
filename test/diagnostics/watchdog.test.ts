import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Clock } from "../../src/adapters/types.js";
import { DEFAULT_WATCHDOG_THRESHOLD_MS, evaluateWatchdog } from "../../src/diagnostics/watchdog.js";
import type { Participant } from "../../src/domain/message.js";
import { PROTOCOL_VERSION } from "../../src/domain/session.js";
import { SQLiteMessageStore } from "../../src/storage/message-store.js";
import { SessionStore } from "../../src/storage/session-store.js";

const PROJECT = "watchdog";
const participants: Participant[] = [
  { project: PROJECT, agentId: "cto", title: "CTO", role: "coordination" },
  { project: PROJECT, agentId: "arch", title: "Architect", role: "review" },
];

let now = Date.parse("2026-11-14T12:00:00.000Z");
const clock: Clock = { now: () => now };

interface Fixture {
  directory: string;
  messages: SQLiteMessageStore;
  sessions: SessionStore;
}

let fixture: Fixture;
const directories: string[] = [];

beforeEach(async () => {
  const directory = await mkdtemp(join(tmpdir(), "synloq-watchdog-"));
  directories.push(directory);
  fixture = {
    directory,
    messages: new SQLiteMessageStore(join(directory, "relay.sqlite")),
    sessions: new SessionStore(join(directory, "relay.sqlite"), clock),
  };
});

afterEach(async () => {
  fixture.sessions.close();
  fixture.messages.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function register(agentId: string, state: "idle" | "busy"): void {
  fixture.sessions.register(
    {
      project: PROJECT,
      agentId,
      sessionId: `session-${agentId}`,
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { activeDelivery: true, stateReporting: true, clientIdempotency: true },
    },
    false,
  );
  fixture.sessions.heartbeat(PROJECT, agentId, `session-${agentId}`, state);
}

function storeOld(agentId: string, ageMs: number, key: string): void {
  fixture.messages.create(
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

function evaluate(thresholdMs?: number) {
  return evaluateWatchdog({
    project: PROJECT,
    participants,
    messages: fixture.messages,
    sessions: fixture.sessions,
    clock,
    ...(thresholdMs === undefined ? {} : { thresholdMs }),
  });
}

describe("evaluateWatchdog", () => {
  it("fires stored-without-delivery on the 2026-11-12 wedge replay (idle session, live channel, old stored)", () => {
    register("cto", "idle");
    storeOld("cto", 40 * 60_000, "000000000001");
    const findings = evaluate();
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ agentId: "cto", kind: "stored-without-delivery" });
    expect(findings[0]!.detail).not.toContain("queued notice");
  });

  it("fires busy-stall when a continuously busy chat holds an old queue (host-side stall replay)", () => {
    register("arch", "busy");
    storeOld("arch", 20 * 60_000, "000000000002");
    const findings = evaluate();
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ agentId: "arch", kind: "busy-stall" });
  });

  it("stays silent on healthy delivery", () => {
    register("cto", "idle");
    register("arch", "busy");
    storeOld("cto", 2 * 60_000, "000000000003");
    storeOld("arch", 2 * 60_000, "000000000004");
    expect(evaluate()).toEqual([]);
  });

  it("stays silent when no messages are stored", () => {
    register("cto", "idle");
    expect(evaluate()).toEqual([]);
  });

  it("stays silent while the stored message is younger than the threshold", () => {
    register("cto", "idle");
    storeOld("cto", DEFAULT_WATCHDOG_THRESHOLD_MS - 60_000, "000000000005");
    expect(evaluate()).toEqual([]);
  });

  it("stays silent for a paused participant even with an old queue", () => {
    register("cto", "idle");
    storeOld("cto", 60 * 60_000, "000000000006");
    fixture.messages.pause(PROJECT, "participant", "cto", new Date(now).toISOString());
    expect(evaluate()).toEqual([]);
  });

  it("stays silent for an unregistered role (covered by session-not-registered)", () => {
    storeOld("cto", 60 * 60_000, "000000000007");
    expect(evaluate()).toEqual([]);
  });

  it("stays silent when the channel is dead (expired lease) — other signals cover it", () => {
    register("cto", "idle");
    storeOld("cto", 40 * 60_000, "000000000008");
    now += 10 * 60_000; // lease expires, heartbeats stop; effective state goes unknown
    expect(evaluate()).toEqual([]);
  });

  it("honours a custom threshold", () => {
    register("cto", "idle");
    storeOld("cto", 5 * 60_000, "000000000009");
    expect(evaluate(10 * 60_000)).toEqual([]);
    expect(evaluate(60_000)).toHaveLength(1);
  });
});
