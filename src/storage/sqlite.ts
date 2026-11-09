import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SynloqError } from "../domain/errors.js";

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
`;

export function storageFailure(message: string, cause: unknown): SynloqError {
  const error = new SynloqError("STORAGE_FAILURE", message);
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

export function openDatabase(path: string): DatabaseSync {
  let database: DatabaseSync | undefined;
  try {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    database = new DatabaseSync(path);
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA journal_mode = WAL");

    const version = database.prepare("PRAGMA user_version").get() as
      { user_version: number } | undefined;
    if (version?.user_version !== 0 && version?.user_version !== 1) {
      throw new Error(`unsupported SQLite user_version: ${version?.user_version}`);
    }

    const migrated = database;
    withTransaction(migrated, () => {
      migrated.exec(schema);
      migrated.exec("PRAGMA user_version = 1");
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
    throw storageFailure("failed to open or migrate SQLite storage", error);
  }
}
