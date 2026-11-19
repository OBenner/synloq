import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import {
  ClaudeNudgeLedger,
  migrateClaudeNudgeLedger,
} from "../../src/storage/claude-nudge-ledger.js";
import { NUDGE_COOLDOWN_MS } from "../../src/storage/nudge-ledger.js";

const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const targetId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const nextTarget = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const attemptId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const request = { project: "p", agentId: "arch", sessionId, targetId, now: NUDGE_COOLDOWN_MS };
const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function v1Ledger() {
  const directory = await mkdtemp(join(tmpdir(), "nudge-ledger-v1-"));
  directories.push(directory);
  const path = join(directory, "ledger.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE ownership(project TEXT, agent TEXT, session TEXT, active INTEGER NOT NULL, PRIMARY KEY(project,agent));
    CREATE TABLE attempts(id TEXT PRIMARY KEY, project TEXT, agent TEXT, session TEXT, target TEXT, marker TEXT, started INTEGER, outcome TEXT NOT NULL, proof INTEGER NOT NULL, targets TEXT NOT NULL);
    CREATE INDEX attempts_role ON attempts(project,agent,started);
    CREATE INDEX attempts_target ON attempts(project,agent,target);
    PRAGMA user_version=1;
  `);
  db.prepare("INSERT INTO attempts VALUES(?,?,?,?,?,?,0,'uncertain',0,?)").run(
    attemptId,
    request.project,
    request.agentId,
    sessionId.toUpperCase(),
    targetId,
    `NUDGE-ACK-${attemptId}`,
    JSON.stringify([targetId]),
  );
  return { path, db };
}

it("accepts a competing migration between the first version read and BEGIN", async () => {
  const { db, path } = await v1Ledger();
  try {
    const before = db.prepare("SELECT * FROM attempts").get();
    const exec = db.exec.bind(db);
    const racingBegin = vi.spyOn(db, "exec").mockImplementationOnce((sql) => {
      expect(sql).toBe("BEGIN IMMEDIATE");
      new ClaudeNudgeLedger(path).close();
      exec(sql);
    });
    migrateClaudeNudgeLedger(db);
    expect(racingBegin).toHaveBeenCalledWith("BEGIN IMMEDIATE");
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    expect(db.prepare("SELECT * FROM attempts").get()).toEqual({ ...before, transcript: null });
    racingBegin.mockClear();
    migrateClaudeNudgeLedger(db);
    expect(racingBegin).not.toHaveBeenCalled();
  } finally {
    db.close();
  }
});

it("keeps one correction across connections and uses it for quarantine and target-success decisions", async () => {
  const { db, path } = await v1Ledger();
  const ledger = new ClaudeNudgeLedger(path);
  const other = new ClaudeNudgeLedger(path);
  try {
    const before = db.prepare("SELECT * FROM attempts WHERE id=?").get(attemptId);
    expect(ledger.reserve({ ...request, targetId: nextTarget })).toBeUndefined();
    // Two offline readers can reach the same conclusion before either writes.
    expect(ledger.findAttempt("p", attemptId)?.corrected).toBe(0);
    expect(other.findAttempt("p", attemptId)?.corrected).toBe(0);
    expect(ledger.recordReverification("p", attemptId, 42)).toBe("verified");
    expect(other.recordReverification("p", attemptId, 99)).toBe("already-verified");
    expect(db.prepare("SELECT * FROM attempts WHERE id=?").get(attemptId)).toEqual(before);
    expect(db.prepare("SELECT verified_at FROM corrections").all()).toEqual([{ verified_at: 42 }]);
    expect(other.reserve({ ...request, sessionId: nextTarget })).toBeUndefined();
    expect(
      other.reserve({ ...request, targetId: nextTarget, transcript: "/trusted/session.jsonl" }),
    ).toBeDefined();
    expect(db.prepare("SELECT transcript FROM attempts WHERE target=?").get(nextTarget)).toEqual({
      transcript: "/trusted/session.jsonl",
    });
    expect(ledger.recordReverification("wrong-project", attemptId, 100)).toBe("not-uncertain");
  } finally {
    other.close();
    ledger.close();
    db.close();
  }
});
