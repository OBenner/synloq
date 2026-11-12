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
import { NullSecurityAuditLog, type AuditedAction, type SecurityAuditLog } from "./audit-log.js";
import type { ProtectionPolicy } from "./protection.js";

export type SendRequest = Omit<SendMessageInput, "project" | "from">;
export type ReplyRequest = Omit<SendRequest, "to" | "inReplyTo"> & {
  inReplyTo: string;
};

export interface InboxRequest {
  project: string;
  agentId: string;
  cursor?: string;
  limit: number;
}

export interface InboxResult {
  messages: Message[];
  nextCursor: string | undefined;
}

export class RelayService {
  constructor(
    private readonly participants: Participant[],
    private readonly messages: SQLiteMessageStore,
    private readonly sessions: SessionStore,
    private readonly protection: ProtectionPolicy,
    private readonly ids: () => string = () => crypto.randomUUID(),
    private readonly clock: Clock = { now: () => Date.now() },
    private readonly audit: SecurityAuditLog = new NullSecurityAuditLog(),
  ) {}

  private recordDeny(identity: Identity, action: AuditedAction, error: unknown): void {
    if (!(error instanceof SynloqError)) return;
    this.audit.record({
      at: new Date(this.clock.now()).toISOString(),
      project: identity.project,
      agentId: identity.operator ? "operator" : identity.agentId,
      action,
      decision: "deny",
      reasonCode: error.code,
      detail: error.message,
    });
  }

  async listParticipants(identity: Identity): Promise<Participant[]> {
    return this.participants.filter((participant) => participant.project === identity.project);
  }

  async send(identity: Identity, raw: SendRequest): Promise<Message> {
    try {
      return await this.performSend(identity, raw);
    } catch (error) {
      this.recordDeny(identity, "send", error);
      throw error;
    }
  }

  private async performSend(identity: Identity, raw: SendRequest): Promise<Message> {
    const input = parseSendMessageInput({
      ...raw,
      project: identity.project,
      from: identity.operator ? "operator" : identity.agentId,
    });
    this.requireParticipant(input.project, input.to);
    const parent = input.inReplyTo ? this.messages.getMessage(input.inReplyTo) : undefined;
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
    if (result.created) this.protection.afterAccept(result.message);
    return result.message;
  }

  pause(identity: Identity, project: string, scope: PauseScope, scopeId: string): void {
    try {
      this.requireOperator(identity, project);
      this.protection.pause(project, scope, scopeId);
    } catch (error) {
      this.recordDeny(identity, "pause", error);
      throw error;
    }
  }

  resume(identity: Identity, project: string, scope: PauseScope, scopeId: string): void {
    try {
      this.requireOperator(identity, project);
      this.protection.resume(project, scope, scopeId);
    } catch (error) {
      this.recordDeny(identity, "resume", error);
      throw error;
    }
  }

  async reply(identity: Identity, raw: ReplyRequest): Promise<Message> {
    try {
      const parent = this.messages.getMessage(raw.inReplyTo);
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

      return this.messages.listInbox(raw.project, raw.agentId, raw.cursor, raw.limit);
    } catch (error) {
      this.recordDeny(identity, "inbox", error);
      throw error;
    }
  }

  async acknowledge(identity: Identity, messageId: string): Promise<Message> {
    try {
      return await this.messages.acknowledge(messageId, identity.project, identity.agentId);
    } catch (error) {
      this.recordDeny(identity, "acknowledge", error);
      throw error;
    }
  }

  async getMessage(identity: Identity, messageId: string): Promise<Message> {
    try {
      const message = this.messages.getMessage(messageId);
      if (!message) throw new SynloqError("NOT_FOUND", "message not found");
      if (
        message.project !== identity.project ||
        (!identity.operator && message.from !== identity.agentId && message.to !== identity.agentId)
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

  private requireParticipant(project: string, agentId: string): void {
    if (
      !this.participants.some(
        (participant) => participant.project === project && participant.agentId === agentId,
      )
    ) {
      throw new SynloqError("UNKNOWN_RECIPIENT", "recipient is not a project participant");
    }
  }
}
