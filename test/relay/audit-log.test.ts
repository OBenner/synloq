import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileSecurityAuditLog,
  NullSecurityAuditLog,
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
    expect(JSON.parse(lines[0])).toEqual(event);
    expect(JSON.parse(lines[1]).action).toBe("acknowledge");
  });
});

describe("NullSecurityAuditLog", () => {
  it("accepts events without side effects", () => {
    expect(() => new NullSecurityAuditLog().record(event)).not.toThrow();
  });
});
