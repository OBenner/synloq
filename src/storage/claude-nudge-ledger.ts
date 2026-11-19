import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { MAX_NUDGES, NUDGE_COOLDOWN_MS } from "./nudge-ledger.js";
import { withTransaction } from "./sqlite.js";

export type ClaudeOutcome = "success" | "external" | "denied" | "uncertain" | "invalid";
export type ClaudeReverification = "verified" | "already-verified" | "not-uncertain";

export interface ClaudeAttempt {
  id: string;
  agentId: string;
  sessionId: string;
  targetId: string;
  targets: string;
  marker: string;
  transcript: string | null;
  outcome: ClaudeOutcome | "reserved";
  corrected: number;
}

const CURRENT_SCHEMA_VERSION = 2;
const CORRECTION_PROOF_VERSION = 1;

export function migrateClaudeNudgeLedger(db: DatabaseSync): void {
  const readVersion = () => {
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    if (version !== 0 && version !== 1 && version !== CURRENT_SCHEMA_VERSION) {
      throw new Error("unsupported Claude ledger");
    }
    return version;
  };
  if (readVersion() === CURRENT_SCHEMA_VERSION) return;
  withTransaction(db, () => {
    const version = readVersion();
    // Another connection can commit the upgrade between the first read and BEGIN.
    if (version === CURRENT_SCHEMA_VERSION) return;
    if (version === 0) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ownership(project TEXT, agent TEXT, session TEXT, active INTEGER NOT NULL, PRIMARY KEY(project,agent));
        CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY, project TEXT, agent TEXT, session TEXT, target TEXT, marker TEXT, started INTEGER, outcome TEXT NOT NULL, proof INTEGER NOT NULL, targets TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS attempts_role ON attempts(project,agent,started);
        CREATE INDEX IF NOT EXISTS attempts_target ON attempts(project,agent,target);
      `);
    }
    db.exec(`
      ALTER TABLE attempts ADD COLUMN transcript TEXT;
      CREATE TABLE corrections(
        attempt_id TEXT NOT NULL PRIMARY KEY REFERENCES attempts(id),
        verified_at INTEGER NOT NULL,
        proof_version INTEGER NOT NULL
      );
      CREATE INDEX attempts_session ON attempts(project,agent,lower(session));
      PRAGMA user_version=${CURRENT_SCHEMA_VERSION};
    `);
  });
}

export class ClaudeNudgeLedger {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    try {
      this.db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
      migrateClaudeNudgeLedger(this.db);
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
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
    transcript?: string;
    now: number;
  }): { id: string; marker: string } | undefined {
    return withTransaction(this.db, () => {
      const { project, agentId, sessionId, targetId, now } = request;
      const latest = this.db
        .prepare(
          "SELECT started FROM attempts WHERE project=? AND agent=? ORDER BY started DESC,rowid DESC LIMIT 1",
        )
        .get(project, agentId) as { started: number } | undefined;
      const blocked = this.db
        .prepare(
          `SELECT 1 FROM attempts a LEFT JOIN corrections c ON c.attempt_id=a.id
           WHERE a.project=? AND a.agent=? AND lower(a.session)=?
           AND a.outcome IN ('reserved','uncertain','denied','invalid') AND c.attempt_id IS NULL LIMIT 1`,
        )
        .get(project, agentId, sessionId.toLowerCase());
      const counts = this.db
        .prepare(
          `SELECT COUNT(*) AS total, COALESCE(SUM(a.outcome='external'),0) AS external,
           COALESCE(SUM(a.outcome='success' OR c.attempt_id IS NOT NULL),0) AS success
           FROM attempts a LEFT JOIN corrections c ON c.attempt_id=a.id
           WHERE a.project=? AND a.agent=? AND a.target=?`,
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
        return undefined;
      }
      const id = randomUUID(),
        marker = `NUDGE-ACK-${id}`;
      this.db
        .prepare(
          `INSERT INTO attempts
          (id,project,agent,session,target,marker,started,outcome,proof,targets,transcript)
          VALUES(?,?,?,?,?,?,?,'reserved',0,?,?)`,
        )
        .run(
          id,
          project,
          agentId,
          sessionId,
          targetId,
          marker,
          now,
          JSON.stringify(request.targetIds ?? [targetId]),
          request.transcript ?? null,
        );
      return { id, marker };
    });
  }
  findAttempt(project: string, id: string): ClaudeAttempt | undefined {
    return this.db
      .prepare(
        `
      SELECT a.id,a.agent AS agentId,a.session AS sessionId,a.target AS targetId,a.targets,
        a.marker,a.transcript,a.outcome,c.attempt_id IS NOT NULL AS corrected
      FROM attempts a LEFT JOIN corrections c ON c.attempt_id=a.id
      WHERE a.project=? AND a.id=?`,
      )
      .get(project, id) as ClaudeAttempt | undefined;
  }
  recordReverification(project: string, id: string, now: number): ClaudeReverification {
    return withTransaction(this.db, () => {
      const attempt = this.findAttempt(project, id);
      if (attempt?.outcome !== "uncertain") return "not-uncertain";
      if (attempt.corrected) return "already-verified";
      // A row here always means the #138 proof passed; the original outcome stays intact.
      this.db
        .prepare("INSERT INTO corrections VALUES(?,?,?)")
        .run(id, now, CORRECTION_PROOF_VERSION);
      return "verified";
    });
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
