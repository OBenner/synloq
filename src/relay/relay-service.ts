import type { Clock } from "../adapters/types.js";
import type { Identity } from "../config/credentials.js";
import { SynloqError } from "../domain/errors.js";
import {
  parseSendMessageInput,
  type Message,
  type Participant,
  type SendMessageInput,
} from "../domain/message.js";
import type { PauseScope, SQLiteMessageStore } from "../storage/message-store.js";
import type { SessionStore } from "../storage/session-store.js";
import {
  denialDetail,
  NullSecurityAuditLog,
  type AuditedAction,
  type SecurityAuditLog,
} from "./audit-log.js";
import { reachTag } from "../config/contact-card.js";
import { StaticParticipantDirectory, type ParticipantDirectory } from "./participant-directory.js";
import type { ProtectionPolicy } from "./protection.js";

export type SendRequest = Omit<SendMessageInput, "project" | "from"> & {
  /** Writer-session proof (issue #46): required when the role has a registered session. */
  sessionId?: string | undefined;
};
export type ReplyRequest = Omit<SendRequest, "to" | "inReplyTo"> & {
  inReplyTo: string;
};

export interface InboxRequest {
  project: string;
  agentId: string;
  cursor?: string;
  limit: number;
  unread?: boolean;
}

export interface InboxResult {
  messages: Message[];
  nextCursor: string | undefined;
}

export interface MessageObserver {
  created(message: Message): void;
  acknowledged(message: Message): void;
}

export class RelayService {
  private readonly directory: ParticipantDirectory;

  constructor(
    participants: Participant[] | ParticipantDirectory,
    private readonly messages: SQLiteMessageStore,
    private readonly sessions: SessionStore,
    private readonly protection: ProtectionPolicy,
    private readonly ids: () => string = () => crypto.randomUUID(),
    private readonly clock: Clock = { now: () => Date.now() },
    private readonly audit: SecurityAuditLog = new NullSecurityAuditLog(),
    private readonly observer?: MessageObserver,
  ) {
    this.directory = Array.isArray(participants)
      ? new StaticParticipantDirectory(participants)
      : participants;
  }

  private recordDeny(identity: Identity, action: AuditedAction, error: unknown): void {
    if (!(error instanceof SynloqError)) return;
    this.audit.record({
      at: new Date(this.clock.now()).toISOString(),
      project: identity.project,
      agentId: identity.operator ? "operator" : identity.agentId,
      action,
      decision: "deny",
      reasonCode: error.code,
      detail: denialDetail(action),
    });
  }

  // Issue #3 (M4-min): operator actions are audited on success too — an
  // incident review needs the pause/resume timeline, not just refusals.
  private recordAccept(identity: Identity, action: AuditedAction, reasonCode: string): void {
    this.audit.record({
      at: new Date(this.clock.now()).toISOString(),
      project: identity.project,
      agentId: identity.operator ? "operator" : identity.agentId,
      action,
      decision: "accept",
      reasonCode,
      detail: `operator action ${action} accepted`,
    });
  }

  async listParticipants(identity: Identity): Promise<Participant[]> {
    const participants = await this.directory.list(identity.project);
    // Issue #108: derived reachability tag for synloq_list. English by
    // convention (relay surfaces stay English); the numbers come from the
    // nudger constants, never literals.
    return Promise.all(
      participants.map(async (participant) => ({
        ...participant,
        reach: reachTag({
          agentId: participant.agentId,
          host: await this.directory.hostOf?.(identity.project, participant.agentId),
        }),
      })),
    );
  }

  async send(identity: Identity, raw: SendRequest): Promise<Message> {
    try {
      return await this.performSend(identity, raw);
    } catch (error) {
      this.recordDeny(identity, "send", error);
      throw error;
    }
  }

  // Issue #46 (single-writer): when the role has a registered session, only
  // that session may write. A second chat holding the role's token reads
  // (inbox/list are token-scoped) but its writes are refused with a pointer
  // to the active writer and replace-session as the only takeover path.
  // Roles without a session (hook-style channels) keep token-only writes.
  private requireWriter(identity: Identity, sessionId: string | undefined): void {
    if (identity.operator) return;
    const writer = this.sessions
      .list(identity.project)
      .find((candidate) => candidate.agentId === identity.agentId);
    if (!writer || writer.sessionId === sessionId) return;
    throw new SynloqError(
      "NOT_WRITER",
      `role '${identity.agentId}' is owned by active writer session '${writer.sessionId}'` +
        (sessionId === undefined ? "" : `, not '${sessionId}'`) +
        "; reads stay open, writes require the owning session — " +
        "take over with synloq replace-session (operator)",
    );
  }

  private async performSend(identity: Identity, raw: SendRequest): Promise<Message> {
    this.requireWriter(identity, raw.sessionId);
    const wire = { ...raw };
    delete wire.sessionId; // writer proof is a transport concern, not message content
    const input = parseSendMessageInput({
      ...wire,
      project: identity.project,
      from: identity.operator ? "operator" : identity.agentId,
    });
    // Protocol v1.1 §2.5 (issue #10): the sender must be a registered
    // participant BEFORE any dedup/replay effect and before any write — an
    // unregistered sender must never receive a replay of someone else's
    // ledger entry. Rejection is synchronous at the acceptance boundary.
    if (!identity.operator) {
      if (identity.agentId === "relay" || identity.agentId === "operator") {
        throw new SynloqError(
          "UNKNOWN_SENDER",
          `reserved id '${identity.agentId}' cannot originate participant messages`,
        );
      }
      await this.requireParticipant(input.project, identity.agentId, "UNKNOWN_SENDER");
    }
    const replay = this.messages.replay(input);
    if (replay) return replay;
    await this.requireParticipant(input.project, input.to);
    const parent = input.inReplyTo
      ? this.messages.getMessage(input.inReplyTo, input.project)
      : undefined;
    if (
      input.inReplyTo &&
      (!parent || parent.to !== identity.agentId || parent.project !== identity.project)
    ) {
      throw new SynloqError("NOT_FOUND", "reply parent not found");
    }

    this.protection.beforeSend(input);
    const result = this.messages.create(
      input,
      this.ids(),
      new Date(this.clock.now()).toISOString(),
      parent?.threadId ?? this.ids(),
    );
    if (result.created) {
      this.protection.afterAccept(result.message);
      try {
        this.observer?.created(result.message);
      } catch {
        /* Observation cannot undo durable send. */
      }
    }
    return result.message;
  }

  pause(identity: Identity, project: string, scope: PauseScope, scopeId: string): void {
    try {
      this.requireOperator(identity, project);
      this.protection.pause(project, scope, scopeId);
      this.recordAccept(identity, "pause", "PAUSED");
    } catch (error) {
      this.recordDeny(identity, "pause", error);
      throw error;
    }
  }

  resume(identity: Identity, project: string, scope: PauseScope, scopeId: string): void {
    try {
      this.requireOperator(identity, project);
      this.protection.resume(project, scope, scopeId);
      this.recordAccept(identity, "resume", "RESUMED");
    } catch (error) {
      this.recordDeny(identity, "resume", error);
      throw error;
    }
  }

  async reply(identity: Identity, raw: ReplyRequest): Promise<Message> {
    try {
      this.requireWriter(identity, raw.sessionId);
      const retryRecipient = this.messages.getRetryRecipient(
        identity.project,
        identity.operator ? "operator" : identity.agentId,
        raw.idempotencyKey,
      );
      if (retryRecipient !== undefined) {
        return await this.performSend(identity, { ...raw, to: retryRecipient });
      }
      const parent = this.messages.getMessage(raw.inReplyTo, identity.project);
      if (!parent || parent.to !== identity.agentId || parent.project !== identity.project) {
        throw new SynloqError("NOT_FOUND", "reply parent not found");
      }

      return await this.performSend(identity, {
        ...raw,
        to: parent.from,
        inReplyTo: parent.id,
      });
    } catch (error) {
      this.recordDeny(identity, "reply", error);
      throw error;
    }
  }

  async inbox(identity: Identity, raw: InboxRequest): Promise<InboxResult> {
    try {
      if (
        raw.project !== identity.project ||
        (!identity.operator && raw.agentId !== identity.agentId)
      ) {
        throw new SynloqError(
          "UNAUTHORIZED",
          "inbox does not belong to the authenticated identity",
        );
      }

      return this.messages.listInbox(raw.project, raw.agentId, raw.cursor, raw.limit, raw.unread);
    } catch (error) {
      this.recordDeny(identity, "inbox", error);
      throw error;
    }
  }

  async acknowledge(identity: Identity, messageId: string, sessionId?: string): Promise<Message> {
    try {
      this.requireWriter(identity, sessionId);
      const message = await this.messages.acknowledge(
        messageId,
        identity.project,
        identity.agentId,
      );
      try {
        this.observer?.acknowledged(message);
      } catch {
        /* ACK remains durable if observation fails. */
      }
      return message;
    } catch (error) {
      this.recordDeny(identity, "acknowledge", error);
      throw error;
    }
  }

  async getMessage(identity: Identity, messageId: string): Promise<Message> {
    try {
      const message = this.messages.getMessage(messageId, identity.project);
      if (!message) throw new SynloqError("NOT_FOUND", "message not found");
      if (
        !identity.operator &&
        message.from !== identity.agentId &&
        message.to !== identity.agentId
      ) {
        throw new SynloqError(
          "UNAUTHORIZED",
          "message does not belong to the authenticated identity",
        );
      }
      return message;
    } catch (error) {
      this.recordDeny(identity, "getMessage", error);
      throw error;
    }
  }

  private requireOperator(identity: Identity, project: string): void {
    if (!identity.operator || identity.project !== project) {
      throw new SynloqError("UNAUTHORIZED", "only a project operator can change pause gates");
    }
  }

  private async requireParticipant(
    project: string,
    agentId: string,
    code: "UNKNOWN_RECIPIENT" | "UNKNOWN_SENDER" = "UNKNOWN_RECIPIENT",
  ): Promise<void> {
    if (await this.directory.isParticipant(project, agentId)) return;
    // The registry may have changed since this relay started (issue #36):
    // force one manifest re-read before rejecting the recipient.
    await this.directory.refresh();
    if (await this.directory.isParticipant(project, agentId)) return;
    throw new SynloqError(
      code,
      code === "UNKNOWN_SENDER"
        ? "sender is not a project participant"
        : "recipient is not a project participant",
    );
  }
}
