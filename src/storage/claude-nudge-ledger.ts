import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { MAX_NUDGES, NUDGE_COOLDOWN_MS } from "./nudge-ledger.js";

export type ClaudeOutcome = "success" | "external" | "denied" | "uncertain" | "invalid";
export class ClaudeNudgeLedger {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    try {
      const version = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
      if (version.user_version !== 0 && version.user_version !== 1)
        throw new Error("unsupported Claude ledger");
      this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS ownership(project TEXT, agent TEXT, session TEXT, active INTEGER NOT NULL, PRIMARY KEY(project,agent));
      CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY, project TEXT, agent TEXT, session TEXT, target TEXT, marker TEXT, started INTEGER, outcome TEXT NOT NULL, proof INTEGER NOT NULL, targets TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS attempts_role ON attempts(project,agent,started);
      CREATE INDEX IF NOT EXISTS attempts_target ON attempts(project,agent,target);
      PRAGMA user_version=1;`);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  ownership(project: string, agent: string, session: string, active: boolean): void {
    this.db
      .prepare("INSERT OR REPLACE INTO ownership VALUES(?,?,?,?)")
      .run(project, agent, session, Number(active));
  }
  reserve(request: {
    project: string;
    agentId: string;
    sessionId: string;
    targetId: string;
    targetIds?: string[];
    now: number;
  }): { id: string; marker: string } | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const { project, agentId, sessionId, targetId, now } = request;
      const latest = this.db
        .prepare(
          "SELECT started FROM attempts WHERE project=? AND agent=? ORDER BY started DESC,rowid DESC LIMIT 1",
        )
        .get(project, agentId) as { started: number } | undefined;
      const blocked = this.db
        .prepare(
          "SELECT 1 FROM attempts WHERE project=? AND agent=? AND lower(session)=? AND outcome IN ('reserved','uncertain','denied','invalid') LIMIT 1",
        )
        .get(project, agentId, sessionId.toLowerCase());
      const counts = this.db
        .prepare(
          "SELECT COUNT(*) AS total, COALESCE(SUM(outcome='external'),0) AS external, COALESCE(SUM(outcome='success'),0) AS success FROM attempts WHERE project=? AND agent=? AND target=?",
        )
        .get(project, agentId, targetId) as { total: number; external: number; success: number };
      // A crash or ambiguous outcome quarantines this session across message targets.
      if (
        blocked ||
        (latest && now - latest.started < NUDGE_COOLDOWN_MS) ||
        counts.total >= MAX_NUDGES ||
        counts.success > 0 ||
        counts.external >= 2
      ) {
        this.db.exec("COMMIT");
        return undefined;
      }
      const id = randomUUID(),
        marker = `NUDGE-ACK-${id}`;
      this.db
        .prepare("INSERT INTO attempts VALUES(?,?,?,?,?,?,?,'reserved',0,?)")
        .run(
          id,
          project,
          agentId,
          sessionId,
          targetId,
          marker,
          now,
          JSON.stringify(request.targetIds ?? [targetId]),
        );
      this.db.exec("COMMIT");
      return { id, marker };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  finish(id: string, outcome: ClaudeOutcome, proof: boolean): void {
    this.db
      .prepare("UPDATE attempts SET outcome=?,proof=? WHERE id=? AND outcome='reserved'")
      .run(outcome, Number(proof), id);
  }
  close(): void {
    this.db.close();
  }
}
