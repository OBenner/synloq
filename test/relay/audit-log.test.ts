import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  auditLogPath,
  FileSecurityAuditLog,
  NullSecurityAuditLog,
  readAuditTail,
  type SecurityEvent,
} from "../../src/relay/audit-log.js";

const event: SecurityEvent = {
  at: "2026-11-12T10:00:00.000Z",
  project: "synloq",
  agentId: "arch",
  action: "inbox",
  decision: "deny",
  reasonCode: "UNAUTHORIZED",
  detail: "inbox does not belong to the authenticated identity",
};

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("FileSecurityAuditLog", () => {
  it("appends one JSON line per event and creates the parent directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "synloq-audit-"));
    dirs.push(dir);
    const log = new FileSecurityAuditLog(join(dir, "nested", "audit.jsonl"));
    log.record(event);
    log.record({ ...event, action: "acknowledge", reasonCode: "UNAUTHORIZED" });
    const lines = readFileSync(join(dir, "nested", "audit.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual(event);
    expect(JSON.parse(lines[1]!).action).toBe("acknowledge");
  });
});

describe("FileSecurityAuditLog growth control (#114)", () => {
  function floodEvent(overrides: Partial<SecurityEvent> = {}): SecurityEvent {
    return { ...event, action: "longPoll", reasonCode: "RATE_LIMITED", ...overrides };
  }

  it("writes the first denial in full, then one aggregate per window", () => {
    const dir = mkdtempSync(join(tmpdir(), "synloq-audit-flood-"));
    dirs.push(dir);
    const path = join(dir, "audit.jsonl");
    let now = Date.parse("2026-11-19T10:00:00.000Z");
    const log = new FileSecurityAuditLog(path, { now: () => now, windowMs: 60_000 });

    for (let i = 0; i < 5000; i++) log.record(floodEvent());

    // Window rolls: the next denial flushes the aggregate and opens a new one.
    now += 60_001;
    log.record(floodEvent());

    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    const first = JSON.parse(lines[0]!);
    expect(first.kind).toBeUndefined(); // full per-event evidence
    expect(first).toMatchObject({ action: "longPoll", decision: "deny" });
    const aggregate = JSON.parse(lines[1]!);
    expect(aggregate).toMatchObject({
      kind: "aggregate",
      action: "longPoll",
      agentId: "arch",
      decision: "deny",
      reasonCode: "RATE_LIMITED",
      count: 5000,
      windowStart: "2026-11-19T10:00:00.000Z",
    });
    expect(JSON.parse(lines[2]!).kind).toBeUndefined();
  });

  it("aggregates per (action, agentId, reasonCode) without mixing reasons", () => {
    const dir = mkdtempSync(join(tmpdir(), "synloq-audit-keys-"));
    dirs.push(dir);
    const path = join(dir, "audit.jsonl");
    const log = new FileSecurityAuditLog(path, { windowMs: 60_000 });

    log.record(floodEvent());
    log.record(floodEvent());
    log.record(floodEvent({ agentId: "cto" })); // different key
    log.record(floodEvent({ action: "send" })); // different action
    log.record(floodEvent({ decision: "accept", reasonCode: "CLAIMED", action: "claim" }));
    for (let i = 0; i < 3; i++) log.record(floodEvent({ reasonCode: "UNAUTHORIZED" }));

    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(5);
    for (const line of lines) expect(JSON.parse(line).kind).toBeUndefined();
    log.flush();
    const aggregates = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as SecurityEvent)
      .filter(
        (entry) =>
          entry.kind === "aggregate" && entry.agentId === "arch" && entry.action === "longPoll",
      );
    expect(aggregates.map(({ reasonCode, count }) => [reasonCode, count])).toEqual([
      ["RATE_LIMITED", 2],
      ["UNAUTHORIZED", 3],
    ]);
  });

  it("readAuditTail reads aggregate rows like ordinary events", async () => {
    const dir = mkdtempSync(join(tmpdir(), "synloq-audit-read-"));
    dirs.push(dir);
    const path = join(dir, "audit.jsonl");
    writeFileSync(
      path,
      `${JSON.stringify(event)}\n${JSON.stringify({ ...event, kind: "aggregate", count: 42, windowStart: event.at })}\n`,
      "utf8",
    );
    const events = await readAuditTail(path, 10);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ kind: "aggregate", count: 42 });
  });
});

describe("NullSecurityAuditLog", () => {
  it("accepts events without side effects", () => {
    expect(() => new NullSecurityAuditLog().record(event)).not.toThrow();
  });
});

describe("append-only guarantee (issue #3)", () => {
  it("never alters previously written lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "synloq-audit-append-"));
    dirs.push(dir);
    const path = join(dir, "audit.jsonl");
    const log = new FileSecurityAuditLog(path);
    log.record(event);
    const afterFirst = readFileSync(path, "utf8");
    log.record({ ...event, action: "rotate", decision: "accept", reasonCode: "ROTATED" });
    log.record({ ...event, action: "pause", decision: "accept", reasonCode: "PAUSED" });
    const afterThird = readFileSync(path, "utf8");
    expect(afterThird.startsWith(afterFirst)).toBe(true);
    expect(afterThird.trim().split("\n")).toHaveLength(3);
  });

  it("exposes no update or delete surface", () => {
    const log = new FileSecurityAuditLog("unused") as unknown as Record<string, unknown>;
    expect(typeof log["record"]).toBe("function");
    expect(log["update"]).toBeUndefined();
    expect(log["delete"]).toBeUndefined();
    expect(log["remove"]).toBeUndefined();
    expect(log["truncate"]).toBeUndefined();
  });
});

describe("readAuditTail (doctor readout, issue #3)", () => {
  it("returns the last N events, skipping malformed lines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "synloq-audit-tail-"));
    dirs.push(dir);
    const path = join(dir, "audit.jsonl");
    const log = new FileSecurityAuditLog(path);
    for (let index = 0; index < 5; index += 1) {
      // Distinct identities: denial aggregation (#114) keys on action+agentId,
      // and this test is about the tail readout, not aggregation.
      log.record({ ...event, agentId: `agent-${index}`, detail: `event-${index}` });
    }
    writeFileSync(path, `${readFileSync(path, "utf8")}not-json\n`, "utf8");

    const tail = await readAuditTail(path, 3);
    expect(tail.map((entry) => entry.detail)).toEqual(["event-2", "event-3", "event-4"]);
  });

  it("reads a missing file as an empty list (offline-safe)", async () => {
    await expect(readAuditTail(join(tmpdir(), "synloq-no-such-audit.jsonl"), 20)).resolves.toEqual(
      [],
    );
  });

  it("resolves the conventional per-project audit path", () => {
    expect(auditLogPath("/home/op/.synloq", "abc123")).toBe(
      join("/home/op/.synloq", "data", "abc123-audit.jsonl"),
    );
  });
});
