import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { QueueResult } from "../host/codex/queue.js";
import { withTransaction } from "./sqlite.js";

export const NUDGE_COOLDOWN_MS = 30 * 60_000;
export const MAX_NUDGES = 5;

interface Attempt {
  count: number;
  state: string;
  exhausted_reported: number;
}
interface Owner {
  message_id: string;
  state: string;
  attempted_at: number;
}

/** Separate local metadata DB: no message text, credentials or session/wire changes. */
export class NudgeLedger {
  private readonly database: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    try {
      this.database.exec(
        "PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL",
      );
      withTransaction(this.database, () => {
        const version = this.database.prepare("PRAGMA user_version").get() as {
          user_version: number;
        };
        if (version.user_version !== 0 && version.user_version !== 1)
          throw new Error("unsupported nudger ledger version");
        this.database.exec(`
          CREATE TABLE IF NOT EXISTS nudge_attempts (
            project TEXT NOT NULL, message_id TEXT NOT NULL, agent_id TEXT NOT NULL,
            target_thread TEXT NOT NULL, count INTEGER NOT NULL CHECK (count BETWEEN 1 AND 5),
            state TEXT NOT NULL, queue_id TEXT, reason TEXT, exhausted_reported INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(project, message_id)
          );
          CREATE TABLE IF NOT EXISTS nudge_owners (
            project TEXT NOT NULL, agent_id TEXT NOT NULL, message_id TEXT NOT NULL,
            state TEXT NOT NULL, attempted_at INTEGER NOT NULL,
            PRIMARY KEY(project, agent_id)
          );
          PRAGMA user_version = 1;
        `);
      });
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  reserve(
    project: string,
    agentId: string,
    messageId: string,
    targetThread: string,
    now: number,
    isAcked: (messageId: string) => boolean,
  ): number | undefined {
    return withTransaction(this.database, () => {
      const owner = this.database
        .prepare(
          "SELECT message_id, state, attempted_at FROM nudge_owners WHERE project = ? AND agent_id = ?",
        )
        .get(project, agentId) as Owner | undefined;
      if (owner) {
        if (owner.state === "reserved") return undefined;
        // A changed head/binding must never evade uncertain or crashed ownership.
        if (!["accepted", "cancelled"].includes(owner.state) && !isAcked(owner.message_id))
          return undefined;
        if (now - owner.attempted_at < NUDGE_COOLDOWN_MS) return undefined;
      }
      const prior = this.database
        .prepare(
          "SELECT count, state, exhausted_reported FROM nudge_attempts WHERE project = ? AND message_id = ?",
        )
        .get(project, messageId) as Attempt | undefined;
      if (prior && (prior.count >= MAX_NUDGES || !["accepted", "cancelled"].includes(prior.state)))
        return undefined;
      const count = (prior?.count ?? 0) + 1;
      this.database
        .prepare(
          `INSERT INTO nudge_attempts (project,message_id,agent_id,target_thread,count,state)
        VALUES (?,?,?,?,?,'reserved') ON CONFLICT(project,message_id) DO UPDATE SET
        target_thread=excluded.target_thread, count=excluded.count, state='reserved', queue_id=NULL, reason=NULL`,
        )
        .run(project, messageId, agentId, targetThread, count);
      this.database
        .prepare(
          `INSERT INTO nudge_owners (project,agent_id,message_id,state,attempted_at)
        VALUES (?,?,?,'reserved',?) ON CONFLICT(project,agent_id) DO UPDATE SET
        message_id=excluded.message_id,state='reserved',attempted_at=excluded.attempted_at`,
        )
        .run(project, agentId, messageId, now);
      return count;
    });
  }

  finish(
    project: string,
    agentId: string,
    messageId: string,
    count: number,
    result: QueueResult,
  ): void {
    withTransaction(this.database, () => {
      const updated = this.database
        .prepare(
          `UPDATE nudge_attempts SET state=?,queue_id=?,reason=?
        WHERE project=? AND message_id=? AND count=? AND state='reserved'`,
        )
        .run(
          result.kind,
          result.kind === "accepted" ? result.queueId : null,
          result.kind === "accepted" ? null : result.code,
          project,
          messageId,
          count,
        );
      if (updated.changes !== 1) throw new Error("nudge reservation lost");
      this.database
        .prepare(
          "UPDATE nudge_owners SET state=? WHERE project=? AND agent_id=? AND message_id=? AND state='reserved'",
        )
        .run(result.kind, project, agentId, messageId);
    });
  }

  /** A bounded diagnostic for a durable blocked owner, without raw CLI output. */
  blockedReason(project: string, agentId: string): string | undefined {
    const owner = this.database
      .prepare("SELECT state FROM nudge_owners WHERE project=? AND agent_id=?")
      .get(project, agentId) as { state: string } | undefined;
    return owner && !["accepted", "cancelled"].includes(owner.state) ? owner.state : undefined;
  }

  /** Claim the terminal diagnostic once across processes/restarts. */
  reportExhausted(project: string, messageId: string): boolean {
    return (
      this.database
        .prepare(
          "UPDATE nudge_attempts SET exhausted_reported=1 WHERE project=? AND message_id=? AND count=5 AND exhausted_reported=0",
        )
        .run(project, messageId).changes === 1
    );
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }
}
