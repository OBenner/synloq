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
      log.record({ ...event, detail: `event-${index}` });
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
