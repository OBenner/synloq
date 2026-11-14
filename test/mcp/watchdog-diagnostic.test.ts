import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Clock } from "../../src/adapters/types.js";
import type { Participant } from "../../src/domain/message.js";
import { PROTOCOL_VERSION } from "../../src/domain/session.js";
import { createWatchdogDiagnostic } from "../../src/mcp/watchdog-diagnostic.js";
import { SQLiteMessageStore } from "../../src/storage/message-store.js";
import { SessionStore } from "../../src/storage/session-store.js";

const PROJECT = "watchdog-diag";
const participants: Participant[] = [
  { project: PROJECT, agentId: "dev", title: "Developer", role: "implementation" },
  { project: PROJECT, agentId: "cto", title: "CTO", role: "coordination" },
];

let now = Date.parse("2026-11-14T12:00:00.000Z");
const clock: Clock = { now: () => now };

let directory: string;
let databasePath: string;
const directories: string[] = [];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "synloq-watchdog-diag-"));
  directories.push(directory);
  databasePath = join(directory, "relay.sqlite");
});

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((entry) => rm(entry, { recursive: true, force: true })),
  );
});

function wedgeOwnQueue(): void {
  const messages = new SQLiteMessageStore(databasePath);
  const sessions = new SessionStore(databasePath, clock);
  try {
    sessions.register(
      {
        project: PROJECT,
        agentId: "dev",
        sessionId: "session-dev",
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { activeDelivery: true, stateReporting: true, clientIdempotency: true },
      },
      false,
    );
    sessions.heartbeat(PROJECT, "dev", "session-dev", "idle");
    messages.create(
      {
        project: PROJECT,
        from: "cto",
        to: "dev",
        text: "wedged notice",
        expectsReply: false,
        idempotencyKey: "wedged-1",
      },
      "11111111-1111-4111-8111-0000000000d1",
      new Date(now - 40 * 60_000).toISOString(),
      "22222222-2222-4222-8222-0000000000d1",
    );
  } finally {
    sessions.close();
    messages.close();
  }
}

function createDiagnostics() {
  const lines: string[] = [];
  return {
    lines,
    sink: { write: (chunk: string) => lines.push(chunk) },
  };
}

describe("createWatchdogDiagnostic", () => {
  it("writes a timestamped stderr line when the own role has a finding", () => {
    wedgeOwnQueue();
    const { lines, sink } = createDiagnostics();
    const watchdog = createWatchdogDiagnostic({
      project: PROJECT,
      agentId: "dev",
      participants,
      databasePath,
      diagnostics: sink,
      clock,
    });
    watchdog.check();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(lines[0]).toContain("stored-without-delivery");
    expect(lines[0]).not.toContain("wedged notice");
  });

  it("reports the same finding only once", () => {
    wedgeOwnQueue();
    const { lines, sink } = createDiagnostics();
    const watchdog = createWatchdogDiagnostic({
      project: PROJECT,
      agentId: "dev",
      participants,
      databasePath,
      diagnostics: sink,
      clock,
    });
    watchdog.check();
    watchdog.check();
    expect(lines).toHaveLength(1);
  });

  it("does not report findings of other roles", () => {
    wedgeOwnQueue();
    const { lines, sink } = createDiagnostics();
    const watchdog = createWatchdogDiagnostic({
      project: PROJECT,
      agentId: "cto",
      participants,
      databasePath,
      diagnostics: sink,
      clock,
    });
    watchdog.check();
    expect(lines).toEqual([]);
  });

  it("stays silent on a healthy queue", () => {
    const { lines, sink } = createDiagnostics();
    const watchdog = createWatchdogDiagnostic({
      project: PROJECT,
      agentId: "dev",
      participants,
      databasePath,
      diagnostics: sink,
      clock,
    });
    watchdog.check();
    expect(lines).toEqual([]);
  });

  it("swallows storage failures instead of breaking the channel", () => {
    const { lines, sink } = createDiagnostics();
    const watchdog = createWatchdogDiagnostic({
      project: PROJECT,
      agentId: "dev",
      participants,
      databasePath: join(directory, "missing", "relay.sqlite"),
      diagnostics: sink,
      clock,
    });
    expect(() => watchdog.check()).not.toThrow();
    expect(lines).toEqual([]);
  });
});
