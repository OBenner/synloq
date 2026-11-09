import type { DatabaseSync } from "node:sqlite";
import type { Clock } from "../adapters/types.js";
import { SynloqError } from "../domain/errors.js";
import {
  PROTOCOL_VERSION,
  type AdapterSession,
  type SessionRegistration,
  type SessionState,
} from "../domain/session.js";
import type { SQLiteMessageStore } from "./message-store.js";
import { openDatabase, storageFailure, withTransaction } from "./sqlite.js";

const LEASE_DURATION_MS = 15_000;
const STATE_FRESHNESS_MS = 5_000;

interface SessionRow {
  project: string;
  agent_id: string;
  session_id: string;
  protocol_version: number;
  active_delivery: number;
  state_reporting: number;
  client_idempotency: number;
  state: SessionState;
  last_heartbeat_at: string;
  state_observed_at: string;
  lease_expires_at: string;
}

const sessionColumns = `
  project, agent_id, session_id, protocol_version, active_delivery, state_reporting,
  client_idempotency, state, last_heartbeat_at, state_observed_at, lease_expires_at
`;

function toSession(row: SessionRow): AdapterSession {
  return {
    project: row.project,
    agentId: row.agent_id,
    sessionId: row.session_id,
    protocolVersion: row.protocol_version,
    capabilities: {
      activeDelivery: row.active_delivery === 1,
      stateReporting: row.state_reporting === 1,
      clientIdempotency: row.client_idempotency === 1,
    },
    state: row.state,
    lastHeartbeatAt: row.last_heartbeat_at,
    stateObservedAt: row.state_observed_at,
    leaseExpiresAt: row.lease_expires_at,
  };
}

export class SessionStore {
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
      throw storageFailure("SQLite session read failed", error);
    }
  }

  private write<T>(operation: () => T): T {
    try {
      return withTransaction(this.database, operation);
    } catch (error) {
      if (error instanceof SynloqError) throw error;
      throw storageFailure("SQLite session write failed", error);
    }
  }

  private find(project: string, agentId: string): SessionRow | undefined {
    return this.database
      .prepare(`SELECT ${sessionColumns} FROM sessions WHERE project = ? AND agent_id = ?`)
      .get(project, agentId) as SessionRow | undefined;
  }

  private findBySessionId(sessionId: string): SessionRow | undefined {
    return this.database
      .prepare(`SELECT ${sessionColumns} FROM sessions WHERE session_id = ?`)
      .get(sessionId) as SessionRow | undefined;
  }

  register(registration: SessionRegistration, replace: boolean): AdapterSession {
    return this.write(() => {
      if (registration.protocolVersion !== PROTOCOL_VERSION) {
        throw new SynloqError(
          "INCOMPATIBLE_PROTOCOL",
          `protocol version ${registration.protocolVersion} is not supported`,
        );
      }

      const existing = this.find(registration.project, registration.agentId);
      if (existing && existing.session_id !== registration.sessionId && !replace) {
        throw new SynloqError(
          "DUPLICATE_SESSION",
          "a different visible session is already bound to this role",
        );
      }
      const sessionOwner = this.findBySessionId(registration.sessionId);
      if (
        sessionOwner &&
        (sessionOwner.project !== registration.project ||
          sessionOwner.agent_id !== registration.agentId)
      ) {
        throw new SynloqError(
          "DUPLICATE_SESSION",
          "the visible session is already bound to another role",
        );
      }

      const now = this.clock.now();
      const observedAt = new Date(now).toISOString();
      const leaseExpiresAt = new Date(now + LEASE_DURATION_MS).toISOString();
      this.database
        .prepare(
          `INSERT INTO sessions (
             project, agent_id, session_id, protocol_version, active_delivery, state_reporting,
             client_idempotency, state, last_heartbeat_at, state_observed_at, lease_expires_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?)
           ON CONFLICT(project, agent_id) DO UPDATE SET
             session_id = excluded.session_id,
             protocol_version = excluded.protocol_version,
             active_delivery = excluded.active_delivery,
             state_reporting = excluded.state_reporting,
             client_idempotency = excluded.client_idempotency,
             state = excluded.state,
             last_heartbeat_at = excluded.last_heartbeat_at,
             state_observed_at = excluded.state_observed_at,
             lease_expires_at = excluded.lease_expires_at`,
        )
        .run(
          registration.project,
          registration.agentId,
          registration.sessionId,
          registration.protocolVersion,
          registration.capabilities.activeDelivery ? 1 : 0,
          registration.capabilities.stateReporting ? 1 : 0,
          registration.capabilities.clientIdempotency ? 1 : 0,
          observedAt,
          observedAt,
          leaseExpiresAt,
        );
      const inserted = this.find(registration.project, registration.agentId);
      if (!inserted) throw new Error("registered session could not be read");
      return toSession(inserted);
    });
  }

  private observe(
    project: string,
    agentId: string,
    sessionId: string,
    state: SessionState,
  ): AdapterSession {
    return this.write(() => {
      const existing = this.find(project, agentId);
      if (!existing) throw new SynloqError("NOT_FOUND", "session not registered");
      if (existing.session_id !== sessionId) {
        throw new SynloqError("UNAUTHORIZED", "session ID does not match the visible binding");
      }

      const now = this.clock.now();
      const observedAt = new Date(now).toISOString();
      const leaseExpiresAt = new Date(now + LEASE_DURATION_MS).toISOString();
      const result = this.database
        .prepare(
          `UPDATE sessions SET state = ?, last_heartbeat_at = ?, state_observed_at = ?,
             lease_expires_at = ? WHERE project = ? AND agent_id = ? AND session_id = ?`,
        )
        .run(state, observedAt, observedAt, leaseExpiresAt, project, agentId, sessionId);
      if (result.changes !== 1) throw new Error("session binding changed during transaction");
      const updated = this.find(project, agentId);
      if (!updated) throw new Error("updated session could not be read");
      return toSession(updated);
    });
  }

  heartbeat(
    project: string,
    agentId: string,
    sessionId: string,
    state: SessionState,
  ): AdapterSession {
    return this.observe(project, agentId, sessionId, state);
  }

  close(): void;
  close(project: string, agentId: string, sessionId: string): AdapterSession;
  close(project?: string, agentId?: string, sessionId?: string): AdapterSession | void {
    if (project !== undefined && agentId !== undefined && sessionId !== undefined) {
      return this.observe(project, agentId, sessionId, "closed");
    }
    if (project !== undefined || agentId !== undefined || sessionId !== undefined) {
      throw new SynloqError(
        "INVALID_INPUT",
        "session close requires project, role, and session ID",
      );
    }
    if (!this.database.isOpen) return;
    try {
      this.database.close();
    } catch (error) {
      throw storageFailure("failed to close SQLite session storage", error);
    }
  }

  effectiveState(project: string, agentId: string): SessionState {
    return this.read(() => {
      const row = this.find(project, agentId);
      if (!row || row.state_reporting !== 1) return "unknown";
      const now = this.clock.now();
      const leaseExpiresAt = Date.parse(row.lease_expires_at);
      const stateObservedAt = Date.parse(row.state_observed_at);
      if (
        !Number.isFinite(leaseExpiresAt) ||
        !Number.isFinite(stateObservedAt) ||
        leaseExpiresAt <= now ||
        now - stateObservedAt > STATE_FRESHNESS_MS
      ) {
        return "unknown";
      }
      return row.state;
    });
  }

  list(project: string): AdapterSession[] {
    return this.read(() => {
      const rows = this.database
        .prepare(
          `SELECT ${sessionColumns} FROM sessions WHERE project = ? ORDER BY agent_id, session_id`,
        )
        .all(project) as unknown as SessionRow[];
      return rows.map(toSession);
    });
  }

  reapExpired(messages: SQLiteMessageStore): void {
    const expired = this.read(() => {
      const now = this.clock.now();
      const rows = this.database
        .prepare(`SELECT ${sessionColumns} FROM sessions ORDER BY project, agent_id`)
        .all() as unknown as SessionRow[];
      return rows.filter(
        (row) => row.client_idempotency === 1 && Date.parse(row.lease_expires_at) <= now,
      );
    });

    for (const row of expired) {
      for (const message of messages.listSubmitted(row.project, row.agent_id)) {
        messages.resetSubmittedForRetry(message.id);
      }
    }
  }
}
