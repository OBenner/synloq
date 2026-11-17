import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isPermissionError, permissionDenied, SynloqError } from "../domain/errors.js";
import { contentHash } from "./dedup.js";

const messageTable = `
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  text TEXT NOT NULL,
  expects_reply INTEGER NOT NULL,
  in_reply_to TEXT,
  created_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  delivery_state TEXT NOT NULL CHECK (delivery_state IN ('stored','submitted','delivered','acked')),
  claim_session_id TEXT,
  claim_generation INTEGER,
  acceptance_consumed_generation INTEGER
);`;

const notesTable = `CREATE TABLE IF NOT EXISTS notes (
  project TEXT NOT NULL,
  role TEXT NOT NULL,
  key TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  PRIMARY KEY(project, role, key)
);
CREATE INDEX IF NOT EXISTS notes_role_updated ON notes(project, role, updated_at);
`;

const schema = `${messageTable}
CREATE INDEX IF NOT EXISTS messages_inbox ON messages(project, recipient, created_at, id);
CREATE UNIQUE INDEX IF NOT EXISTS messages_fifo ON messages(project, recipient, created_at, id);
CREATE INDEX IF NOT EXISTS messages_retention ON messages(project, delivery_state, created_at, id);
CREATE TABLE IF NOT EXISTS message_dedup (
  project TEXT NOT NULL,
  sender TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  recipient TEXT NOT NULL,
  expects_reply INTEGER NOT NULL,
  in_reply_to TEXT,
  created_at TEXT NOT NULL,
  delivery_state TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  first_accepted_at TEXT NOT NULL,
  PRIMARY KEY(project, sender, idempotency_key)
);
CREATE INDEX IF NOT EXISTS dedup_expiry ON message_dedup(project, first_accepted_at);
CREATE INDEX IF NOT EXISTS dedup_message ON message_dedup(id);
CREATE TABLE IF NOT EXISTS pause_gates (
  project TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('project','participant','thread')),
  scope_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(project, scope, scope_id)
);
CREATE TABLE IF NOT EXISTS sessions (
  project TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL UNIQUE,
  protocol_version INTEGER NOT NULL,
  active_delivery INTEGER NOT NULL CHECK (active_delivery IN (0, 1)),
  state_reporting INTEGER NOT NULL CHECK (state_reporting IN (0, 1)),
  client_idempotency INTEGER NOT NULL CHECK (client_idempotency IN (0, 1)),
  state TEXT NOT NULL CHECK (state IN ('idle','busy','closed','unknown')),
  last_heartbeat_at TEXT NOT NULL,
  state_observed_at TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1,
  acceptance_message_id TEXT,
  PRIMARY KEY(project, agent_id)
);
CREATE TABLE IF NOT EXISTS delivery_quarantine (
  message_id TEXT PRIMARY KEY REFERENCES messages(id),
  project TEXT NOT NULL,
  recipient TEXT NOT NULL,
  quarantined_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS delivery_quarantine_recipient
  ON delivery_quarantine(project, recipient);
${notesTable}`;

// Common node:sqlite errcodes (sqlite3.h) — surfaced in STORAGE_FAILURE so a
// live incident shows BUSY vs LOCKED vs IOERR instead of an opaque "write
// failed" (issue #68).
const SQLITE_ERROR_NAMES = new Map<number, string>([
  [5, "SQLITE_BUSY"],
  [6, "SQLITE_LOCKED"],
  [8, "SQLITE_READONLY"],
  [10, "SQLITE_IOERR"],
  [11, "SQLITE_CORRUPT"],
  [13, "SQLITE_FULL"],
  [14, "SQLITE_CANTOPEN"],
]);

function sqliteErrorCode(cause: unknown): string | undefined {
  if (typeof cause !== "object" || cause === null) return undefined;
  const errcode = (cause as { errcode?: unknown }).errcode;
  if (typeof errcode !== "number") return undefined;
  return SQLITE_ERROR_NAMES.get(errcode) ?? `SQLITE_ERROR_${errcode}`;
}

export function storageFailure(message: string, cause: unknown): SynloqError {
  const code = sqliteErrorCode(cause);
  const error = new SynloqError("STORAGE_FAILURE", code ? `${message} [${code}]` : message);
  error.cause = cause;
  return error;
}

export function withTransaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "SQLite transaction and rollback failed", {
        cause: error,
      });
    }
    throw error;
  }
}

/** Current on-disk schema version. Bumped by additive forward-only migrations. */
export const CURRENT_SCHEMA_VERSION = 6;

/**
 * Whether the v5-rebuild transaction should run, given the version re-read
 * INSIDE BEGIN IMMEDIATE. A racing migrator may have committed CURRENT while
 * this connection still holds the pre-transaction read (#106 review, 2026-11-17)
 * — skipping on CURRENT is what keeps that race fail-soft instead of
 * "unsupported user_version". Unknown versions stay a hard refuse.
 */
export function v5RebuildDecision(
  lockedVersion: number | undefined,
): "rebuild" | "skip" | "refuse" {
  if (lockedVersion === 5 || lockedVersion === CURRENT_SCHEMA_VERSION) return "skip";
  if (
    typeof lockedVersion !== "number" ||
    lockedVersion < 0 ||
    lockedVersion > CURRENT_SCHEMA_VERSION
  )
    return "refuse";
  return "rebuild";
}

export function openDatabase(path: string, options?: { readOnly?: boolean }): DatabaseSync {
  const readOnly = options?.readOnly === true && path !== ":memory:";
  let database: DatabaseSync | undefined;
  try {
    if (path !== ":memory:" && !readOnly) mkdirSync(dirname(path), { recursive: true });
    database = new DatabaseSync(path, readOnly ? { readOnly: true } : {});
    database.exec("PRAGMA foreign_keys = ON");
    // Issue #68: every connection — relay writer and diagnostic readers alike —
    // waits on locks instead of failing instantly with SQLITE_BUSY. This is the
    // bounded busy-retry, implemented inside SQLite rather than as an
    // app-level retry loop (decision recorded in the #68 PR).
    database.exec("PRAGMA busy_timeout = 5000");
    const version = database.prepare("PRAGMA user_version").get() as
      { user_version: number } | undefined;
    if (version?.user_version !== undefined && version.user_version > CURRENT_SCHEMA_VERSION) {
      // Issue #113: a newer database on an older binary — the classic
      // downgrade path. Name both versions and the escape hatch; migrations
      // are forward-only, so an old binary must refuse instead of guessing.
      throw new SynloqError(
        "STORAGE_FAILURE",
        `the project database uses schema version ${version.user_version}, but this synloq ` +
          `supports up to ${CURRENT_SCHEMA_VERSION}. Upgrade synloq (npm i -g synloq@latest or ` +
          "npx synloq@latest) to open it; downgrading requires exporting your data first — " +
          'database migrations are forward-only (see README, "Database migrations").',
      );
    }
    if (version?.user_version === undefined || version.user_version < 0) {
      throw new Error(`unsupported SQLite user_version: ${version?.user_version}`);
    }

    if (readOnly) {
      // Diagnostics never migrate or take a write lock, even on older schemas.
      return database;
    }
    database.exec("PRAGMA journal_mode = WAL");

    // Issue #68: skip the migration write transaction entirely when the schema
    // is already current — otherwise every connection open (including the
    // per-tick diagnostic opens) takes a BEGIN IMMEDIATE write lock on the
    // shared file and contends with the relay writer.
    if (version?.user_version === CURRENT_SCHEMA_VERSION) {
      return database;
    }

    const migrated = database;
    // Rebuild messages to remove both the parent FK and permanent key uniqueness.
    // Foreign keys are disabled only on this connection and outside the transaction;
    // validate the remaining quarantine FK before committing the forward migration.
    migrated.exec("PRAGMA foreign_keys = OFF");
    withTransaction(migrated, () => {
      // Another process may have migrated while BEGIN IMMEDIATE waited — all
      // the way to CURRENT (v6), not just to the v5 rebuild this transaction
      // performs.
      const lockedVersion = migrated.prepare("PRAGMA user_version").get()?.user_version;
      const decision = v5RebuildDecision(lockedVersion as number | undefined);
      if (decision === "skip") return;
      if (decision === "refuse") {
        throw new Error(`unsupported SQLite user_version: ${lockedVersion}`);
      }
      migrated.exec(schema);
      const additions = [
        ["messages", "claim_session_id", "TEXT"],
        ["messages", "claim_generation", "INTEGER"],
        ["messages", "acceptance_consumed_generation", "INTEGER"],
        ["sessions", "generation", "INTEGER NOT NULL DEFAULT 1"],
        ["sessions", "acceptance_message_id", "TEXT"],
      ] as const;
      for (const [table, column, definition] of additions) {
        const columns = migrated.prepare(`PRAGMA table_info(${table})`).all() as Array<{
          name: string;
        }>;
        if (!columns.some((entry) => entry.name === column)) {
          migrated.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        }
      }
      migrated.exec(messageTable.replace("IF NOT EXISTS messages", "messages_v5"));
      migrated.exec(`INSERT INTO messages_v5 SELECT
        id, project, thread_id, sender, recipient, text, expects_reply, in_reply_to,
        created_at, idempotency_key, delivery_state, claim_session_id, claim_generation,
        acceptance_consumed_generation FROM messages`);
      migrated.exec("DROP TABLE messages; ALTER TABLE messages_v5 RENAME TO messages;");
      migrated.exec(schema);
      const insertDedup = migrated.prepare(`INSERT INTO message_dedup
        (project, sender, idempotency_key, id, thread_id, recipient, expects_reply,
         in_reply_to, created_at, delivery_state, content_hash, first_accepted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const row of migrated.prepare("SELECT * FROM messages").iterate()) {
        insertDedup.run(
          row.project!,
          row.sender!,
          row.idempotency_key!,
          row.id!,
          row.thread_id!,
          row.recipient!,
          row.expects_reply!,
          row.in_reply_to!,
          row.created_at!,
          row.delivery_state!,
          contentHash({
            to: row.recipient as string,
            text: row.text as string,
            expectsReply: row.expects_reply === 1,
            ...(row.in_reply_to === null ? {} : { inReplyTo: row.in_reply_to as string }),
          }),
          row.created_at!,
        );
      }
      if (migrated.prepare("PRAGMA foreign_key_check").all().length > 0) {
        throw new Error("foreign key validation failed during retention migration");
      }
      migrated.exec("PRAGMA user_version = 5");
    });
    // Issue #22: additive notes table for per-role memory. A second transaction
    // keeps the 0→5 rebuild untouched; v5 databases enter here (the early skip
    // above now targets v6) and only gain the notes table. Racing migrators
    // wait on BEGIN IMMEDIATE and see 6.
    withTransaction(migrated, () => {
      const lockedVersion = migrated.prepare("PRAGMA user_version").get()?.user_version;
      if (lockedVersion === 6) return;
      if (typeof lockedVersion !== "number" || lockedVersion < 0 || lockedVersion > 6) {
        throw new Error(`unsupported SQLite user_version: ${lockedVersion}`);
      }
      migrated.exec(notesTable);
      migrated.exec("PRAGMA user_version = 6");
    });
    migrated.exec("PRAGMA foreign_keys = ON");
    return database;
  } catch (error) {
    if (database?.isOpen) {
      try {
        database.close();
      } catch {
        // Preserve the original open or migration failure.
      }
    }
    if (error instanceof SynloqError) throw error;
    if (isPermissionError(error)) {
      throw permissionDenied("opening the SQLite storage", path, error);
    }
    throw storageFailure("failed to open or migrate SQLite storage", error);
  }
}
