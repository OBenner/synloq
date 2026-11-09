import type { DatabaseSync } from "node:sqlite";
import { SynloqError } from "../domain/errors.js";
import type { Message, SendMessageInput } from "../domain/message.js";
import { openDatabase, storageFailure, withTransaction } from "./sqlite.js";

interface MessageRow {
  id: string;
  project: string;
  thread_id: string;
  sender: string;
  recipient: string;
  text: string;
  expects_reply: number;
  in_reply_to: string | null;
  created_at: string;
  idempotency_key: string;
  delivery_state: Message["deliveryState"];
}

interface CreateResult {
  message: Message;
  created: boolean;
}

interface InboxPage {
  messages: Message[];
  nextCursor: string | undefined;
}

interface PendingUsage {
  count: number;
  bytes: number;
}

export type PauseScope = "project" | "participant" | "thread";

const messageColumns = `
  id, project, thread_id, sender, recipient, text, expects_reply, in_reply_to,
  created_at, idempotency_key, delivery_state
`;

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    project: row.project,
    threadId: row.thread_id,
    from: row.sender,
    to: row.recipient,
    text: row.text,
    expectsReply: row.expects_reply === 1,
    ...(row.in_reply_to === null ? {} : { inReplyTo: row.in_reply_to }),
    createdAt: row.created_at,
    idempotencyKey: row.idempotency_key,
    deliveryState: row.delivery_state,
  };
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      typeof value !== "object" ||
      value === null ||
      !("createdAt" in value) ||
      typeof value.createdAt !== "string" ||
      !("id" in value) ||
      typeof value.id !== "string"
    ) {
      throw new Error("invalid cursor shape");
    }
    return { createdAt: value.createdAt, id: value.id };
  } catch {
    throw new SynloqError("INVALID_INPUT", "invalid inbox cursor");
  }
}

function encodeCursor(message: Message): string {
  return Buffer.from(
    JSON.stringify({ createdAt: message.createdAt, id: message.id }),
    "utf8",
  ).toString("base64url");
}

export class SQLiteMessageStore {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = openDatabase(path);
  }

  private read<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof SynloqError) throw error;
      throw storageFailure("SQLite read failed", error);
    }
  }

  private write<T>(operation: () => T): T {
    try {
      return withTransaction(this.database, operation);
    } catch (error) {
      if (error instanceof SynloqError) throw error;
      throw storageFailure("SQLite write failed", error);
    }
  }

  private findById(id: string): MessageRow | undefined {
    return this.database.prepare(`SELECT ${messageColumns} FROM messages WHERE id = ?`).get(id) as
      MessageRow | undefined;
  }

  create(input: SendMessageInput, id: string, createdAt: string, threadId: string): CreateResult {
    return this.write(() => {
      const existing = this.database
        .prepare(
          `SELECT ${messageColumns} FROM messages
           WHERE project = ? AND sender = ? AND idempotency_key = ?`,
        )
        .get(input.project, input.from, input.idempotencyKey) as MessageRow | undefined;

      if (existing) {
        const message = toMessage(existing);
        if (
          message.to !== input.to ||
          message.text !== input.text ||
          message.expectsReply !== input.expectsReply ||
          message.inReplyTo !== input.inReplyTo
        ) {
          throw new SynloqError(
            "IDEMPOTENCY_CONFLICT",
            "idempotency key was already used with different content",
          );
        }
        return { message, created: false };
      }

      this.database
        .prepare(
          `INSERT INTO messages (
             id, project, thread_id, sender, recipient, text, expects_reply, in_reply_to,
             created_at, idempotency_key, delivery_state
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'stored')`,
        )
        .run(
          id,
          input.project,
          threadId,
          input.from,
          input.to,
          input.text,
          input.expectsReply ? 1 : 0,
          input.inReplyTo ?? null,
          createdAt,
          input.idempotencyKey,
        );
      const inserted = this.findById(id);
      if (!inserted) throw new Error("inserted message could not be read");
      return { message: toMessage(inserted), created: true };
    });
  }

  getByIdempotency(project: string, sender: string, idempotencyKey: string): Message | undefined {
    return this.read(() => {
      const row = this.database
        .prepare(
          `SELECT ${messageColumns} FROM messages
           WHERE project = ? AND sender = ? AND idempotency_key = ?`,
        )
        .get(project, sender, idempotencyKey) as MessageRow | undefined;
      return row ? toMessage(row) : undefined;
    });
  }

  getMessage(id: string): Message | undefined {
    return this.read(() => {
      const row = this.findById(id);
      return row ? toMessage(row) : undefined;
    });
  }

  listInbox(
    project: string,
    recipient: string,
    cursor: string | undefined,
    limit: number,
  ): InboxPage {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new SynloqError("INVALID_INPUT", "inbox limit must be an integer from 1 to 100");
    }
    const position = cursor === undefined ? undefined : decodeCursor(cursor);

    return this.read(() => {
      const rows = (position
        ? this.database
            .prepare(
              `SELECT ${messageColumns} FROM messages
                 WHERE project = ? AND recipient = ?
                   AND (created_at > ? OR (created_at = ? AND id > ?))
                 ORDER BY created_at, id LIMIT ?`,
            )
            .all(project, recipient, position.createdAt, position.createdAt, position.id, limit + 1)
        : this.database
            .prepare(
              `SELECT ${messageColumns} FROM messages
                 WHERE project = ? AND recipient = ?
                 ORDER BY created_at, id LIMIT ?`,
            )
            .all(project, recipient, limit + 1)) as unknown as MessageRow[];

      const hasMore = rows.length > limit;
      const messages = rows.slice(0, limit).map(toMessage);
      const last = messages.at(-1);
      return {
        messages,
        nextCursor: hasMore && last ? encodeCursor(last) : undefined,
      };
    });
  }

  nextPending(project: string, recipient: string): Message | undefined {
    return this.read(() => {
      const row = this.database
        .prepare(
          `SELECT ${messageColumns} FROM messages AS candidate
           WHERE candidate.project = ? AND candidate.recipient = ?
             AND candidate.delivery_state = 'stored'
             AND NOT EXISTS (
               SELECT 1 FROM messages AS blocker
               WHERE blocker.project = candidate.project
                 AND blocker.recipient = candidate.recipient
                 AND blocker.delivery_state = 'submitted'
                 AND (
                   blocker.created_at < candidate.created_at OR
                   (blocker.created_at = candidate.created_at AND blocker.id < candidate.id)
                 )
             )
           ORDER BY candidate.created_at, candidate.id LIMIT 1`,
        )
        .get(project, recipient) as MessageRow | undefined;
      return row ? toMessage(row) : undefined;
    });
  }

  private transition(row: MessageRow, target: Message["deliveryState"]): Message {
    const legal =
      (row.delivery_state === "stored" && target === "submitted") ||
      (row.delivery_state === "submitted" && target === "delivered") ||
      (row.delivery_state === "delivered" && target === "acked");
    if (!legal) {
      throw new SynloqError(
        "INVALID_INPUT",
        `invalid delivery transition: ${row.delivery_state} to ${target}`,
      );
    }

    const result = this.database
      .prepare("UPDATE messages SET delivery_state = ? WHERE id = ? AND delivery_state = ?")
      .run(target, row.id, row.delivery_state);
    if (result.changes !== 1) throw new Error("delivery state changed during transaction");
    const updated = this.findById(row.id);
    if (!updated) throw new Error("updated message could not be read");
    return toMessage(updated);
  }

  setDeliveryState(id: string, target: Message["deliveryState"]): Message {
    return this.write(() => {
      const row = this.findById(id);
      if (!row) throw new SynloqError("NOT_FOUND", "message not found");
      if (row.delivery_state === "stored" && target === "delivered") {
        this.transition(row, "submitted");
        const submitted = this.findById(id);
        if (!submitted) throw new Error("submitted message could not be read");
        return this.transition(submitted, "delivered");
      }
      return this.transition(row, target);
    });
  }

  listSubmitted(project: string, recipient: string): Message[] {
    return this.read(() => {
      const rows = this.database
        .prepare(
          `SELECT ${messageColumns} FROM messages
           WHERE project = ? AND recipient = ? AND delivery_state = 'submitted'
           ORDER BY created_at, id`,
        )
        .all(project, recipient) as unknown as MessageRow[];
      return rows.map(toMessage);
    });
  }

  resetSubmittedForExpiredLease(id: string, reapedAt: string): void {
    this.write(() => {
      this.database
        .prepare(
          `UPDATE messages SET delivery_state = 'stored'
           WHERE id = ? AND delivery_state = 'submitted'
             AND EXISTS (
               SELECT 1 FROM sessions
               WHERE sessions.project = messages.project
                 AND sessions.agent_id = messages.recipient
                 AND sessions.client_idempotency = 1
                 AND sessions.lease_expires_at <= ?
             )
             AND NOT EXISTS (
               SELECT 1 FROM pause_gates
               WHERE pause_gates.project = messages.project
                 AND pause_gates.scope = 'participant'
                 AND pause_gates.scope_id = messages.recipient
             )`,
        )
        .run(id, reapedAt);
    });
  }

  resetSubmittedForRetry(id: string): Message {
    return this.write(() => {
      const row = this.findById(id);
      if (!row) throw new SynloqError("NOT_FOUND", "message not found");
      if (row.delivery_state !== "submitted") {
        throw new SynloqError("INVALID_INPUT", "only a submitted message can be reset for retry");
      }
      const result = this.database
        .prepare(
          "UPDATE messages SET delivery_state = 'stored' WHERE id = ? AND delivery_state = 'submitted'",
        )
        .run(id);
      if (result.changes !== 1) throw new Error("delivery state changed during transaction");
      const updated = this.findById(id);
      if (!updated) throw new Error("reset message could not be read");
      return toMessage(updated);
    });
  }

  acknowledge(id: string, project: string, recipient: string): Message {
    return this.write(() => {
      const row = this.findById(id);
      if (!row) throw new SynloqError("NOT_FOUND", "message not found");
      if (row.project !== project || row.recipient !== recipient) {
        throw new SynloqError("UNAUTHORIZED", "only the recipient can acknowledge a message");
      }
      if (row.delivery_state === "acked") return toMessage(row);
      return this.transition(row, "acked");
    });
  }

  pendingUsage(project: string, recipient: string): PendingUsage {
    return this.read(() => {
      const row = this.database
        .prepare(
          `SELECT COUNT(*) AS count,
                  COALESCE(SUM(LENGTH(CAST(text AS BLOB))), 0) AS bytes
           FROM messages
           WHERE project = ? AND recipient = ?
             AND delivery_state IN ('stored', 'submitted')`,
        )
        .get(project, recipient) as { count: number; bytes: number };
      return { count: Number(row.count), bytes: Number(row.bytes) };
    });
  }

  countThreadSince(threadId: string, since: string): number {
    return this.read(() => {
      const row = this.database
        .prepare(
          `SELECT COUNT(*) AS count FROM messages
           WHERE thread_id = ? AND created_at >= ?`,
        )
        .get(threadId, since) as { count: number };
      return Number(row.count);
    });
  }

  pause(project: string, scope: PauseScope, scopeId: string, createdAt: string): void {
    this.write(() => {
      this.database
        .prepare(
          `INSERT INTO pause_gates (project, scope, scope_id, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(project, scope, scope_id) DO NOTHING`,
        )
        .run(project, scope, scopeId, createdAt);
    });
  }

  resume(project: string, scope: PauseScope, scopeId: string): void {
    this.write(() => {
      this.database
        .prepare("DELETE FROM pause_gates WHERE project = ? AND scope = ? AND scope_id = ?")
        .run(project, scope, scopeId);
    });
  }

  isPaused(project: string, scope: PauseScope, scopeId: string): boolean {
    return this.read(() => {
      const row = this.database
        .prepare(
          `SELECT 1 AS paused FROM pause_gates
           WHERE project = ? AND (scope = 'project' OR (scope = ? AND scope_id = ?))
           LIMIT 1`,
        )
        .get(project, scope, scopeId);
      return row !== undefined;
    });
  }

  close(): void {
    if (!this.database.isOpen) return;
    try {
      this.database.close();
    } catch (error) {
      throw storageFailure("failed to close SQLite storage", error);
    }
  }
}
