import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { SynloqError } from "../domain/errors.js";
import { withTransaction } from "./sqlite.js";

export const NOTE_KEY_MAX = 128;
export const NOTE_BODY_MAX = 65_536;
export const NOTES_PER_ROLE_MAX = 256;

const keySchema = z.string().min(1).max(NOTE_KEY_MAX);
const bodySchema = z.string().max(NOTE_BODY_MAX);

export interface Note {
  key: string;
  body: string;
  updatedAt: string;
}

/**
 * Relay-side per-role memory notes (#22). Rows are scoped by (project, role,
 * key); the role comes from the authenticated identity, never from the
 * request. Notes are local tooling — never routed between participants, no
 * shadow channel. The message retention sweep (#4) does not touch this table;
 * growth is bounded by NOTES_PER_ROLE_MAX instead.
 */
export class NotesStore {
  constructor(database: DatabaseSync) {
    this.database = database;
  }

  private readonly database: DatabaseSync;

  write(project: string, role: string, key: string, body: string, now: string): Note {
    const parsedKey = keySchema.safeParse(key);
    if (!parsedKey.success) {
      throw new SynloqError("INVALID_INPUT", `note key must be 1..${NOTE_KEY_MAX} characters`);
    }
    if (!bodySchema.safeParse(body).success) {
      throw new SynloqError(
        "INVALID_INPUT",
        `note body must be at most ${NOTE_BODY_MAX} characters`,
      );
    }
    return withTransaction(this.database, () => {
      const count = (
        this.database
          .prepare("SELECT COUNT(*) AS count FROM notes WHERE project = ? AND role = ?")
          .get(project, role) as { count: number }
      ).count;
      const existing = this.database
        .prepare("SELECT 1 AS present FROM notes WHERE project = ? AND role = ? AND key = ?")
        .get(project, role, parsedKey.data);
      if (!existing && count >= NOTES_PER_ROLE_MAX) {
        throw new SynloqError(
          "STORAGE_FAILURE",
          `note key limit reached for role (max ${NOTES_PER_ROLE_MAX})`,
        );
      }
      this.database
        .prepare(
          `INSERT INTO notes (project, role, key, body, updated_at, content_hash)
           VALUES (?,?,?,?,?,?)
           ON CONFLICT(project, role, key) DO UPDATE SET
             body=excluded.body, updated_at=excluded.updated_at, content_hash=excluded.content_hash`,
        )
        .run(
          project,
          role,
          parsedKey.data,
          body,
          now,
          createHash("sha256").update(body).digest("hex"),
        );
      return { key: parsedKey.data, body, updatedAt: now };
    });
  }

  read(project: string, role: string, key: string): Note | undefined {
    const row = this.database
      .prepare("SELECT key, body, updated_at FROM notes WHERE project = ? AND role = ? AND key = ?")
      .get(project, role, key) as { key: string; body: string; updated_at: string } | undefined;
    if (!row) return undefined;
    return { key: row.key, body: row.body, updatedAt: row.updated_at };
  }

  count(project: string, role: string): number {
    return (
      this.database
        .prepare("SELECT COUNT(*) AS count FROM notes WHERE project = ? AND role = ?")
        .get(project, role) as { count: number }
    ).count;
  }

  /** Doctor surface: aggregate stats without exposing bodies. */
  stats(project: string): { roles: number; notes: number; oldest?: string; newest?: string } {
    const row = this.database
      .prepare(
        `SELECT COUNT(DISTINCT role) AS roles, COUNT(*) AS notes,
                MIN(updated_at) AS oldest, MAX(updated_at) AS newest
         FROM notes WHERE project = ?`,
      )
      .get(project) as {
      roles: number;
      notes: number;
      oldest: string | null;
      newest: string | null;
    };
    return {
      roles: row.roles,
      notes: row.notes,
      ...(row.oldest ? { oldest: row.oldest } : {}),
      ...(row.newest ? { newest: row.newest } : {}),
    };
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }
}
