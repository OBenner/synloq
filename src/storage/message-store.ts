import type { DatabaseSync } from "node:sqlite";
import type { Clock, DeliveryReceipt } from "../adapters/types.js";
import { SynloqError } from "../domain/errors.js";
import type { Message, SendMessageInput } from "../domain/message.js";
import type { SessionBinding } from "../domain/session.js";
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
  claim_session_id: string | null;
  claim_generation: number | null;
  acceptance_consumed_generation: number | null;
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

export interface ClaimedDelivery extends SessionBinding {
  message: Message;
  /** Stored deliveries still queued behind the claimed one. */
  pendingAfter?: number;
}

interface DeliverySessionRow {
  session_id: string;
  generation: number;
  active_delivery: number;
  state_reporting: number;
  client_idempotency: number;
  state: "idle" | "busy" | "closed" | "unknown";
  state_observed_at: string;
  lease_expires_at: string;
  acceptance_message_id: string | null;
}

const messageColumns = `
  id, project, thread_id, sender, recipient, text, expects_reply, in_reply_to,
  created_at, idempotency_key, delivery_state, claim_session_id, claim_generation,
  acceptance_consumed_generation
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

  constructor(
    path: string,
    private readonly clock: Clock = { now: () => Date.now() },
  ) {
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
                 AND NOT EXISTS (
                   SELECT 1 FROM delivery_quarantine
                   WHERE delivery_quarantine.message_id = blocker.id
                 )
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

  private deliverySession(
    project: string,
    recipient: string,
    binding: SessionBinding,
  ): DeliverySessionRow {
    const row = this.database
      .prepare(
        `SELECT session_id, generation, active_delivery, state_reporting, client_idempotency,
                state, state_observed_at, lease_expires_at, acceptance_message_id
         FROM sessions WHERE project = ? AND agent_id = ?`,
      )
      .get(project, recipient) as DeliverySessionRow | undefined;
    if (!row || row.session_id !== binding.sessionId || row.generation !== binding.generation) {
      throw new SynloqError(
        "UNAUTHORIZED",
        "delivery session registration is stale or does not match the visible binding",
      );
    }
    return row;
  }

  private deliveryReady(
    session: DeliverySessionRow,
    project: string,
    recipient: string,
    threadId?: string,
  ): boolean {
    const now = this.clock.now();
    const leaseExpiresAt = Date.parse(session.lease_expires_at);
    const stateObservedAt = Date.parse(session.state_observed_at);
    return (
      session.active_delivery === 1 &&
      session.state_reporting === 1 &&
      session.state === "idle" &&
      Number.isFinite(leaseExpiresAt) &&
      Number.isFinite(stateObservedAt) &&
      leaseExpiresAt > now &&
      now - stateObservedAt <= 5_000 &&
      !this.isPaused(project, "project", "") &&
      !this.isPaused(project, "participant", recipient) &&
      (threadId === undefined || !this.isPaused(project, "thread", threadId))
    );
  }

  claimNextDelivery(
    project: string,
    recipient: string,
    binding: SessionBinding,
  ): ClaimedDelivery | null {
    return this.write(() => {
      const session = this.deliverySession(project, recipient, binding);
      if (!this.deliveryReady(session, project, recipient)) return null;
      const pendingRow = this.database
        .prepare(
          `SELECT ${messageColumns} FROM messages AS candidate
           WHERE candidate.project = ? AND candidate.recipient = ?
             AND candidate.delivery_state = 'stored'
             AND NOT EXISTS (
               SELECT 1 FROM messages AS blocker
               WHERE blocker.project = candidate.project
                 AND blocker.recipient = candidate.recipient
                 AND blocker.delivery_state = 'submitted'
                 AND NOT EXISTS (
                   SELECT 1 FROM delivery_quarantine
                   WHERE delivery_quarantine.message_id = blocker.id
                 )
                 AND (
                   blocker.created_at < candidate.created_at OR
                   (blocker.created_at = candidate.created_at AND blocker.id < candidate.id)
                 )
             )
           ORDER BY candidate.created_at, candidate.id LIMIT 1`,
        )
        .get(project, recipient) as MessageRow | undefined;
      if (!pendingRow || this.isPaused(project, "thread", pendingRow.thread_id)) return null;
      if (
        session.acceptance_message_id !== null &&
        (pendingRow.id !== session.acceptance_message_id ||
          pendingRow.acceptance_consumed_generation !== null)
      ) {
        return null;
      }

      const result = this.database
        .prepare(
          `UPDATE messages SET delivery_state = 'submitted', claim_session_id = ?,
             claim_generation = ?,
             acceptance_consumed_generation = CASE
               WHEN ? IS NOT NULL AND ? = id THEN ?
               ELSE acceptance_consumed_generation
             END
           WHERE id = ? AND delivery_state = 'stored'`,
        )
        .run(
          binding.sessionId,
          binding.generation,
          session.acceptance_message_id,
          session.acceptance_message_id,
          binding.generation,
          pendingRow.id,
        );
      if (result.changes !== 1) throw new Error("pending delivery changed during claim");
      return { message: toMessage(pendingRow), ...binding };
    });
  }

  authorizeDelivery(
    id: string,
    project: string,
    recipient: string,
    binding: SessionBinding,
  ): Message {
    return this.write(() => {
      const row = this.findById(id);
      if (!row || row.project !== project || row.recipient !== recipient) {
        throw new SynloqError("UNAUTHORIZED", "delivery does not belong to the recipient");
      }
      const session = this.deliverySession(project, recipient, binding);
      if (
        row.delivery_state !== "submitted" ||
        row.claim_session_id !== binding.sessionId ||
        row.claim_generation !== binding.generation
      ) {
        throw new SynloqError("UNAUTHORIZED", "delivery claim is stale or no longer submitted");
      }
      if (!this.deliveryReady(session, project, recipient, row.thread_id)) {
        throw new SynloqError(
          "INVALID_INPUT",
          "visible session is not freshly idle and unpaused for submission",
        );
      }
      return toMessage(row);
    });
  }

  private completionClaim(
    id: string,
    project: string,
    recipient: string,
    binding: SessionBinding,
  ): { row: MessageRow; session: DeliverySessionRow } {
    const row = this.findById(id);
    if (!row || row.project !== project || row.recipient !== recipient) {
      throw new SynloqError("UNAUTHORIZED", "delivery does not belong to the recipient");
    }
    const session = this.deliverySession(project, recipient, binding);
    if (session.state === "closed") {
      throw new SynloqError("UNAUTHORIZED", "the claiming visible session is closed");
    }
    if (row.claim_session_id !== binding.sessionId || row.claim_generation !== binding.generation) {
      throw new SynloqError("UNAUTHORIZED", "delivery completion uses a stale claim");
    }
    return { row, session };
  }

  completeDeliveryReceipt(
    id: string,
    project: string,
    recipient: string,
    binding: SessionBinding,
    receipt: DeliveryReceipt,
  ): Message {
    return this.write(() => {
      const before = this.findById(id);
      if (
        receipt.evidence &&
        (receipt.state !== "delivered" ||
          !before ||
          (before.delivery_state !== "submitted" && before.delivery_state !== "delivered"))
      ) {
        throw new SynloqError("INVALID_INPUT", "delivery evidence requires a submitted message");
      }
      const { row } = this.completionClaim(id, project, recipient, binding);
      const evidence = receipt.evidence;
      if (
        evidence &&
        (receipt.clientMessageId !== id ||
          evidence.messageId !== id ||
          evidence.sessionId !== binding.sessionId ||
          evidence.generation !== binding.generation ||
          evidence.project !== row.project ||
          evidence.from !== row.sender ||
          evidence.threadId !== row.thread_id)
      ) {
        throw new SynloqError(
          "INVALID_INPUT",
          "delivery evidence provenance does not match the submitted claim",
        );
      }

      if (receipt.state === "submitted") {
        if (["submitted", "delivered", "acked"].includes(row.delivery_state)) {
          return toMessage(row);
        }
        throw new SynloqError("INVALID_INPUT", "submitted evidence requires a claimed message");
      }
      if (row.delivery_state === "delivered" || row.delivery_state === "acked") {
        return toMessage(row);
      }
      if (row.delivery_state !== "submitted") {
        throw new SynloqError("INVALID_INPUT", "only a submitted message can be delivered");
      }
      return this.transition(row, "delivered");
    });
  }

  reportDeliveryFailure(
    id: string,
    project: string,
    recipient: string,
    binding: SessionBinding,
    code: "RETRYABLE" | "DELIVERY_UNCERTAIN",
    clientIdempotency: boolean,
  ): Message {
    return this.write(() => {
      const row = this.findById(id);
      if (!row || row.project !== project || row.recipient !== recipient) {
        throw new SynloqError("UNAUTHORIZED", "delivery does not belong to the recipient");
      }
      const session = this.deliverySession(project, recipient, binding);
      if (session.state === "closed") {
        throw new SynloqError("UNAUTHORIZED", "the claiming visible session is closed");
      }
      if (row.delivery_state === "stored" && code === "RETRYABLE") return toMessage(row);
      if (
        row.delivery_state !== "submitted" ||
        row.claim_session_id !== binding.sessionId ||
        row.claim_generation !== binding.generation
      ) {
        throw new SynloqError("UNAUTHORIZED", "delivery failure uses a stale claim");
      }

      // Uncertain outcomes release back to the queue instead of quarantining:
      // resubmission is probe-gated by the adapter (history reconcile or client
      // idempotency), so a transient host hiccup must not mute the participant.
      // clientIdempotency is retained in the signature for wire compatibility.
      void clientIdempotency;
      const result = this.database
        .prepare(
          `UPDATE messages SET delivery_state = 'stored', claim_session_id = NULL,
           claim_generation = NULL,
           acceptance_consumed_generation = CASE
             WHEN ? = 'RETRYABLE' THEN NULL ELSE acceptance_consumed_generation
           END
           WHERE id = ? AND delivery_state = 'submitted'`,
        )
        .run(code, id);
      if (result.changes !== 1) throw new Error("delivery state changed during failure report");
      const updated = this.findById(id);
      if (!updated) throw new Error("reset message could not be read");
      return toMessage(updated);
    });
  }

  /**
   * Releases quarantined deliveries of a participant back into the FIFO queue.
   * Called on (re)registration: a fresh generation is the natural reconcile
   * point, and resubmission is probe-gated by the receiving adapter.
   */
  releaseQuarantinedDeliveries(project: string, recipient: string): number {
    return this.write(() => {
      const released = this.database
        .prepare(
          `UPDATE messages SET delivery_state = 'stored', claim_session_id = NULL,
             claim_generation = NULL
           WHERE project = ? AND recipient = ? AND delivery_state = 'submitted'
             AND acceptance_consumed_generation IS NULL
             AND EXISTS (
               SELECT 1 FROM delivery_quarantine
               WHERE delivery_quarantine.message_id = messages.id
                 AND delivery_quarantine.project = messages.project
                 AND delivery_quarantine.recipient = messages.recipient
             )`,
        )
        .run(project, recipient);
      this.database
        .prepare("DELETE FROM delivery_quarantine WHERE project = ? AND recipient = ?")
        .run(project, recipient);
      return Number(released.changes);
    });
  }

  /** Age source for status: oldest still-stored delivery of a recipient. */
  oldestStoredAt(project: string, recipient: string): string | undefined {
    return this.read(() => {
      const row = this.database
        .prepare(
          `SELECT MIN(created_at) AS oldest FROM messages
           WHERE project = ? AND recipient = ? AND delivery_state = 'stored'`,
        )
        .get(project, recipient) as { oldest: string | null };
      return row.oldest ?? undefined;
    });
  }

  /** Delivered but not yet acknowledged deliveries of a recipient. */
  awaitingAck(project: string, recipient: string): { count: number; oldestAt?: string } {
    return this.read(() => {
      const row = this.database
        .prepare(
          `SELECT COUNT(*) AS count, MIN(created_at) AS oldest FROM messages
           WHERE project = ? AND recipient = ? AND delivery_state = 'delivered'`,
        )
        .get(project, recipient) as { count: number | bigint; oldest: string | null };
      const count = Number(row.count);
      return { count, ...(row.oldest === null ? {} : { oldestAt: row.oldest }) };
    });
  }

  /**
   * Acknowledged deliveries that expected a reply but have none older than
   * the given ISO timestamp — the objective under-processing signal used by
   * `synloq status` and the TEAM.md backlog sweep rule.
   */
  unansweredAcked(
    project: string,
    recipient: string,
    olderThanIso: string,
  ): { count: number; oldestAt?: string } {
    return this.read(() => {
      const row = this.database
        .prepare(
          `SELECT COUNT(*) AS count, MIN(m.created_at) AS oldest FROM messages AS m
           WHERE m.project = ? AND m.recipient = ? AND m.delivery_state = 'acked'
             AND m.expects_reply = 1 AND m.created_at < ?
             AND NOT EXISTS (
               SELECT 1 FROM messages AS r WHERE r.in_reply_to = m.id
             )`,
        )
        .get(project, recipient, olderThanIso) as { count: number | bigint; oldest: string | null };
      const count = Number(row.count);
      return { count, ...(row.oldest === null ? {} : { oldestAt: row.oldest }) };
    });
  }

  /** Stored deliveries queued for a recipient (for the "+N more pending" hint). */
  countStored(project: string, recipient: string): number {
    return this.read(() => {
      const row = this.database
        .prepare(
          `SELECT COUNT(*) AS count FROM messages
           WHERE project = ? AND recipient = ? AND delivery_state = 'stored'`,
        )
        .get(project, recipient) as { count: number | bigint };
      return Number(row.count);
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

  setDeliveryState(
    id: string,
    target: Message["deliveryState"],
    binding?: SessionBinding,
  ): Message {
    return this.write(() => {
      const row = this.findById(id);
      if (!row) throw new SynloqError("NOT_FOUND", "message not found");
      if (row.delivery_state === "stored" && target === "delivered") {
        this.transition(row, "submitted");
        const submitted = this.findById(id);
        if (!submitted) throw new Error("submitted message could not be read");
        return this.transition(submitted, "delivered");
      }
      const transitioned = this.transition(row, target);
      if (target === "submitted" && binding) {
        this.database
          .prepare(
            `UPDATE messages SET claim_session_id = ?, claim_generation = ?,
               acceptance_consumed_generation = CASE
                 WHEN EXISTS (
                   SELECT 1 FROM sessions
                   WHERE sessions.project = messages.project
                     AND sessions.agent_id = messages.recipient
                     AND sessions.session_id = ? AND sessions.generation = ?
                     AND sessions.acceptance_message_id = messages.id
                 ) THEN ? ELSE acceptance_consumed_generation
               END
             WHERE id = ?`,
          )
          .run(
            binding.sessionId,
            binding.generation,
            binding.sessionId,
            binding.generation,
            binding.generation,
            id,
          );
        const claimed = this.findById(id);
        if (!claimed) throw new Error("claimed message could not be read");
        return toMessage(claimed);
      }
      return transitioned;
    });
  }

  quarantineDelivery(id: string, project: string, recipient: string, createdAt: string): Message {
    return this.write(() => {
      const row = this.findById(id);
      if (!row) throw new SynloqError("NOT_FOUND", "message not found");
      if (row.project !== project || row.recipient !== recipient) {
        throw new SynloqError("INVALID_INPUT", "quarantine recipient does not match the message");
      }
      if (row.delivery_state === "stored") this.transition(row, "submitted");
      if (row.delivery_state !== "stored" && row.delivery_state !== "submitted") {
        throw new SynloqError("INVALID_INPUT", "only a pending message can be quarantined");
      }

      this.database
        .prepare(
          `INSERT INTO delivery_quarantine (message_id, project, recipient, quarantined_at)
           VALUES (?, ?, ?, ?) ON CONFLICT(message_id) DO NOTHING`,
        )
        .run(id, project, recipient, createdAt);
      const quarantined = this.findById(id);
      if (!quarantined) throw new Error("quarantined message could not be read");
      return toMessage(quarantined);
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
          `UPDATE messages SET delivery_state = 'stored', claim_session_id = NULL,
             claim_generation = NULL
           WHERE id = ? AND delivery_state = 'submitted'
             AND acceptance_consumed_generation IS NULL
             AND EXISTS (
               SELECT 1 FROM sessions
               WHERE sessions.project = messages.project
                 AND sessions.agent_id = messages.recipient
                 AND sessions.client_idempotency = 1
                 AND sessions.lease_expires_at <= ?
                 AND (
                   messages.claim_generation IS NULL OR
                   (messages.claim_generation = sessions.generation AND
                    messages.claim_session_id = sessions.session_id)
                 )
             )
             AND NOT EXISTS (
               SELECT 1 FROM delivery_quarantine
               WHERE delivery_quarantine.message_id = messages.id
                 AND delivery_quarantine.project = messages.project
                 AND delivery_quarantine.recipient = messages.recipient
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
          `UPDATE messages SET delivery_state = 'stored', claim_session_id = NULL,
           claim_generation = NULL WHERE id = ? AND delivery_state = 'submitted'`,
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
      if (row.delivery_state === "stored") this.transition(row, "submitted");

      const submitted = this.findById(id);
      if (!submitted) throw new Error("submitted message could not be read");
      if (submitted.delivery_state === "submitted") this.transition(submitted, "delivered");

      const delivered = this.findById(id);
      if (!delivered) throw new Error("delivered message could not be read");
      return this.transition(delivered, "acked");
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
