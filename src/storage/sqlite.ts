import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isPermissionError, permissionDenied, SynloqError } from "../domain/errors.js";

const schema = `
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  text TEXT NOT NULL,
  expects_reply INTEGER NOT NULL,
  in_reply_to TEXT REFERENCES messages(id),
  created_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  delivery_state TEXT NOT NULL CHECK (delivery_state IN ('stored','submitted','delivered','acked')),
  claim_session_id TEXT,
  claim_generation INTEGER,
  acceptance_consumed_generation INTEGER,
  UNIQUE(project, sender, idempotency_key)
);
CREATE INDEX IF NOT EXISTS messages_inbox ON messages(project, recipient, created_at, id);
CREATE UNIQUE INDEX IF NOT EXISTS messages_fifo ON messages(project, recipient, created_at, id);
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
`;

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
    if (readOnly) {
      // Read-only consumers (watchdog, stored-ping, doctor, status) must not
      // take a write lock: no journal_mode pragma, no migration transaction.
      return database;
    }
    database.exec("PRAGMA journal_mode = WAL");

    const version = database.prepare("PRAGMA user_version").get() as
      { user_version: number } | undefined;
    if (
      version?.user_version !== 0 &&
      version?.user_version !== 1 &&
      version?.user_version !== 2 &&
      version?.user_version !== 3 &&
      version?.user_version !== 4
    ) {
      throw new Error(`unsupported SQLite user_version: ${version?.user_version}`);
    }

    // Issue #68: skip the migration write transaction entirely when the schema
    // is already current — otherwise every connection open (including the
    // per-tick diagnostic opens) takes a BEGIN IMMEDIATE write lock on the
    // shared file and contends with the relay writer.
    if (version?.user_version === 4) {
      return database;
    }

    const migrated = database;
    withTransaction(migrated, () => {
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
      migrated.exec("PRAGMA user_version = 4");
    });
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
