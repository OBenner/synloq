import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";
import type { CredentialStore, Identity } from "../config/credentials.js";
import { SynloqError } from "../domain/errors.js";
import { agentId, type Message } from "../domain/message.js";
import { PROTOCOL_VERSION, type SessionBinding } from "../domain/session.js";
import { NullSecurityAuditLog, type SecurityAuditLog } from "../relay/audit-log.js";
import type { Dispatcher } from "../relay/dispatcher.js";
import type { ProtectionPolicy } from "../relay/protection.js";
import type { RelayService } from "../relay/relay-service.js";
import type { SQLiteMessageStore } from "../storage/message-store.js";
import type { SessionStore } from "../storage/session-store.js";

const MAX_JSON_BYTES = 64 * 1024;
const SHUTDOWN_EVENT = "shutdown";

const capabilitiesSchema = z
  .object({
    activeDelivery: z.boolean(),
    stateReporting: z.boolean(),
    clientIdempotency: z.boolean(),
  })
  .strict();
const sessionFields = {
  sessionId: z.string().min(1).max(256),
  protocolVersion: z.number().int().positive(),
  capabilities: capabilitiesSchema,
};
const sendSchema = z
  .object({
    to: agentId,
    text: z.string().min(1),
    expectsReply: z.boolean(),
    inReplyTo: z.string().uuid().optional(),
    idempotencyKey: z.string().min(1).max(128),
  })
  .strict();
const replySchema = z
  .object({
    inReplyTo: z.string().uuid(),
    text: z.string().min(1),
    expectsReply: z.boolean(),
    idempotencyKey: z.string().min(1).max(128),
  })
  .strict();
const inboxQuerySchema = z
  .object({
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    waitMs: z.coerce.number().int().min(0).max(25_000).default(0),
    unread: z.literal("1").optional(),
  })
  .strict();
const bindingFields = {
  sessionId: sessionFields.sessionId,
  generation: z.coerce.number().int().positive(),
};
const bindingSchema = z.object(bindingFields).strict();
const deliveryQuerySchema = bindingSchema.extend({
  waitMs: z.coerce.number().int().min(0).max(25_000).default(0),
});
const acknowledgeSchema = z.object({ messageId: z.string().uuid() }).strict();
const registerSchema = z
  .object({
    ...sessionFields,
    acceptanceMessageId: z.string().uuid().optional(),
  })
  .strict();
const heartbeatSchema = z
  .object({
    sessionId: sessionFields.sessionId,
    state: z.enum(["idle", "busy", "closed", "unknown"]),
    generation: z.coerce.number().int().positive().optional(),
  })
  .strict();
const closeSchema = z.object({ sessionId: sessionFields.sessionId }).strict();
const messageIdSchema = z.string().uuid();
const receiptEvidenceSchema = z
  .object({
    ...bindingFields,
    project: z.string().min(1).max(128),
    from: agentId,
    messageId: messageIdSchema,
    threadId: z.string().min(1).max(256),
  })
  .strict();
const receiptSchema = z
  .object({
    ...bindingFields,
    state: z.enum(["submitted", "delivered"]),
    clientMessageId: z.string().min(1).max(256).optional(),
    evidence: receiptEvidenceSchema.optional(),
  })
  .strict();
const deliveryFailureSchema = z
  .object({
    ...bindingFields,
    code: z.enum(["RETRYABLE", "DELIVERY_UNCERTAIN"]),
    clientIdempotency: z.boolean(),
  })
  .strict();
const pauseSchema = z
  .object({
    scope: z.enum(["project", "participant", "thread"]),
    scopeId: z.string().max(256),
  })
  .strict();
const replaceSchema = z.object({ agentId, ...sessionFields }).strict();

export interface RelayHttpServerOptions {
  project: string;
  relay: RelayService;
  credentials: CredentialStore;
  sessions: SessionStore;
  dispatcher: Dispatcher;
  messages: SQLiteMessageStore;
  audit?: SecurityAuditLog;
  // When present, long-poll routes (waitMs > 0) acquire a per-identity slot
  // from this policy and release it when the request ends (security M2).
  protection?: ProtectionPolicy;
}

interface ErrorResponse {
  status: number;
  error: SynloqError;
}

export class RelayHttpServer {
  private readonly http: Server;
  private readonly events = new EventEmitter();
  private readonly audit: SecurityAuditLog;
  private closing = false;

  constructor(private readonly options: RelayHttpServerOptions) {
    this.events.setMaxListeners(0);
    this.audit = options.audit ?? new NullSecurityAuditLog();
    this.http = createServer((request, response) => {
      void this.handle(request, response);
    });
  }

  listen(host: string, port: number): Promise<string> {
    if (host !== "127.0.0.1" && host !== "::1") {
      throw new SynloqError("INVALID_INPUT", "relay HTTP listen address must be loopback");
    }
    if (this.closing) throw new SynloqError("INVALID_INPUT", "relay HTTP server is closed");

    return new Promise((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.http.once("error", onError);
      this.http.listen(port, host, () => {
        this.http.off("error", onError);
        const address = this.http.address();
        if (address === null || typeof address === "string") {
          reject(new Error("relay HTTP server did not expose a TCP address"));
          return;
        }
        const urlHost = host === "::1" ? "[::1]" : host;
        resolve(`http://${urlHost}:${address.port}`);
      });
    });
  }

  close(): Promise<void> {
    if (!this.http.listening) return Promise.resolve();
    this.closing = true;
    this.events.emit(SHUTDOWN_EVENT);

    return new Promise((resolve, reject) => {
      this.http.close((error) => {
        if (error) reject(error);
        else resolve();
      });
      this.http.closeIdleConnections();
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://loopback");
    if (request.method === "GET" && url.pathname === "/v1/health") {
      // Unauthenticated compatibility marker: lets probes verify the service
      // before any credential is sent. Carries no project or session data.
      this.sendJson(response, 200, { service: "synloq-relay", protocolVersion: PROTOCOL_VERSION });
      return;
    }

    let identity: Identity;
    try {
      identity = await this.authenticate(request.headers.authorization);
    } catch (error) {
      if (error instanceof SynloqError) {
        this.audit.record({
          at: new Date().toISOString(),
          project: this.options.project,
          agentId: "unknown",
          action: "authenticate",
          decision: "deny",
          reasonCode: error.code,
          detail: error.message,
        });
      }
      this.sendError(response, error, true);
      return;
    }

    try {
      await this.route(request, response, url, identity);
    } catch (error) {
      this.sendError(response, error, false);
    }
  }

  private async authenticate(header: string | undefined): Promise<Identity> {
    const match = header === undefined ? undefined : /^Bearer ([^\s]+)$/.exec(header);
    if (!match?.[1]) throw new SynloqError("UNAUTHORIZED", "a bearer credential is required");
    return this.options.credentials.authenticate(this.options.project, match[1]);
  }

  private async route(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    identity: Identity,
  ): Promise<void> {
    const method = request.method;
    const path = url.pathname;
    const { project } = this.options;

    if (method === "GET" && path === "/v1/participants") {
      this.sendJson(response, 200, {
        participants: await this.options.relay.listParticipants(identity),
      });
      return;
    }

    if (method === "POST" && path === "/v1/messages") {
      const input = sendSchema.parse(await this.readJson(request));
      const message = await this.options.relay.send(identity, input);
      this.accepted(message);
      this.sendJson(response, 200, { message });
      return;
    }

    if (method === "POST" && path === "/v1/replies") {
      const input = replySchema.parse(await this.readJson(request));
      const message = await this.options.relay.reply(identity, input);
      this.accepted(message);
      this.sendJson(response, 200, { message });
      return;
    }

    if (method === "GET" && path === "/v1/inbox") {
      const query = inboxQuerySchema.parse(Object.fromEntries(url.searchParams));
      const release = this.acquireLongPollSlot(identity, query.waitMs);
      try {
        const result = await this.waitFor(
          this.workEvent(project, identity.agentId),
          query.waitMs,
          response,
          () =>
            this.options.relay.inbox(identity, {
              project,
              agentId: identity.agentId,
              ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
              limit: query.limit,
              ...(query.unread === undefined ? {} : { unread: true }),
            }),
          (value) => value.messages.length > 0,
        );
        this.sendJson(response, 200, result);
      } finally {
        release?.();
      }
      return;
    }

    if (method === "POST" && path === "/v1/ack") {
      const input = acknowledgeSchema.parse(await this.readJson(request));
      const message = await this.options.relay.acknowledge(identity, input.messageId);
      this.sendJson(response, 200, { message });
      return;
    }

    if (method === "POST" && path === "/v1/sessions/register") {
      const input = registerSchema.parse(await this.readJson(request));
      const session = this.options.sessions.register(
        {
          sessionId: input.sessionId,
          protocolVersion: input.protocolVersion,
          capabilities: input.capabilities,
          ...(input.acceptanceMessageId === undefined
            ? {}
            : { acceptanceMessageId: input.acceptanceMessageId }),
          project,
          agentId: identity.agentId,
        },
        false,
      );
      this.changed(project, identity.agentId);
      this.sendJson(response, 200, { session });
      return;
    }

    if (method === "POST" && path === "/v1/sessions/heartbeat") {
      const input = heartbeatSchema.parse(await this.readJson(request));
      const session = this.options.sessions.heartbeat(
        project,
        identity.agentId,
        input.sessionId,
        input.state,
        input.generation,
      );
      this.changed(project, identity.agentId);
      this.sendJson(response, 200, { session });
      return;
    }

    if (method === "POST" && path === "/v1/sessions/close") {
      const input = closeSchema.parse(await this.readJson(request));
      const session = this.options.sessions.close(project, identity.agentId, input.sessionId);
      this.changed(project, identity.agentId);
      this.sendJson(response, 200, { session });
      return;
    }

    if (method === "GET" && path === "/v1/deliveries/next") {
      const query = deliveryQuerySchema.parse(Object.fromEntries(url.searchParams));
      const release = this.acquireLongPollSlot(identity, query.waitMs);
      try {
        const result = await this.waitFor(
          this.workEvent(project, identity.agentId),
          query.waitMs,
          response,
          () =>
            this.nextDelivery(identity, {
              sessionId: query.sessionId,
              generation: query.generation,
            }),
          (value) => value.message !== null,
        );
        this.sendJson(response, 200, result);
      } finally {
        release?.();
      }
      return;
    }

    const authorizeMatch = /^\/v1\/deliveries\/([^/]+)\/authorize$/.exec(path);
    if (method === "POST" && authorizeMatch) {
      const messageId = messageIdSchema.parse(decodeURIComponent(authorizeMatch[1] ?? ""));
      const binding = bindingSchema.parse(await this.readJson(request));
      const message = this.options.messages.authorizeDelivery(
        messageId,
        project,
        identity.agentId,
        binding,
      );
      this.sendJson(response, 200, { message });
      return;
    }

    const receiptMatch = /^\/v1\/deliveries\/([^/]+)\/receipt$/.exec(path);
    if (method === "POST" && receiptMatch) {
      const messageId = messageIdSchema.parse(decodeURIComponent(receiptMatch[1] ?? ""));
      const input = receiptSchema.parse(await this.readJson(request));
      const existing = this.options.messages.getMessage(messageId);
      if (!existing) throw new SynloqError("NOT_FOUND", "message not found");
      if (existing.project !== project || existing.to !== identity.agentId) {
        throw new SynloqError(
          "UNAUTHORIZED",
          "only the authenticated recipient can post a delivery receipt",
        );
      }
      const message = this.options.messages.completeDeliveryReceipt(
        messageId,
        project,
        identity.agentId,
        { sessionId: input.sessionId, generation: input.generation },
        {
          state: input.state,
          ...(input.clientMessageId === undefined
            ? {}
            : { clientMessageId: input.clientMessageId }),
          ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
        },
      );
      this.events.emit(this.workEvent(project, identity.agentId));
      this.sendJson(response, 200, { message });
      return;
    }

    const failureMatch = /^\/v1\/deliveries\/([^/]+)\/failure$/.exec(path);
    if (method === "POST" && failureMatch) {
      const messageId = messageIdSchema.parse(decodeURIComponent(failureMatch[1] ?? ""));
      const input = deliveryFailureSchema.parse(await this.readJson(request));
      const existing = this.options.messages.getMessage(messageId);
      if (!existing) throw new SynloqError("NOT_FOUND", "message not found");
      if (existing.project !== project || existing.to !== identity.agentId) {
        throw new SynloqError(
          "UNAUTHORIZED",
          "only the authenticated recipient can report a delivery failure",
        );
      }
      const message = this.options.messages.reportDeliveryFailure(
        messageId,
        project,
        identity.agentId,
        input,
        input.code,
        input.clientIdempotency,
      );
      this.events.emit(this.workEvent(project, identity.agentId));
      this.sendJson(response, 200, { message });
      return;
    }

    if (method === "POST" && path === "/v1/operator/pause") {
      const input = pauseSchema.parse(await this.readJson(request));
      this.options.relay.pause(identity, project, input.scope, input.scopeId);
      this.sendJson(response, 200, { ok: true });
      return;
    }

    if (method === "POST" && path === "/v1/operator/resume") {
      const input = pauseSchema.parse(await this.readJson(request));
      this.options.relay.resume(identity, project, input.scope, input.scopeId);
      for (const session of this.options.sessions.list(project)) {
        this.changed(project, session.agentId);
      }
      this.sendJson(response, 200, { ok: true });
      return;
    }

    if (method === "POST" && path === "/v1/operator/replace-session") {
      this.requireOperator(identity);
      const input = replaceSchema.parse(await this.readJson(request));
      const session = this.options.sessions.register({ ...input, project }, true);
      this.changed(project, input.agentId);
      this.sendJson(response, 200, { session });
      return;
    }

    if (method === "GET" && path === "/v1/operator/doctor") {
      this.requireOperator(identity);
      this.sendJson(response, 200, {
        sessions: this.options.sessions.list(project),
      });
      return;
    }

    throw new SynloqError("NOT_FOUND", "route not found");
  }

  private nextDelivery(identity: Identity, binding: SessionBinding) {
    const claimed = this.options.messages.claimNextDelivery(
      this.options.project,
      identity.agentId,
      binding,
    );
    if (!claimed) return { message: null, ...binding };
    const remaining = this.options.messages.countStored(this.options.project, identity.agentId);
    return { ...claimed, ...(remaining > 0 ? { pendingAfter: remaining } : {}) };
  }

  private accepted(message: Message): void {
    this.changed(message.project, message.to);
  }

  private changed(project: string, agentId: string): void {
    this.events.emit(this.workEvent(project, agentId));
    void this.options.dispatcher.kick(project, agentId).catch(() => {
      // The durable queue remains authoritative; a later event can retry dispatch.
    });
  }

  private workEvent(project: string, agentId: string): string {
    return `work:${project}:${agentId}`;
  }

  // Instant polls (waitMs = 0) never hold a slot: they do not park a
  // connection. Long polls acquire before the first read so the cap also
  // covers the initial wait; the release runs in the caller's finally, which
  // includes client aborts (response close resolves the wait).
  private acquireLongPollSlot(identity: Identity, waitMs: number): (() => void) | undefined {
    if (waitMs <= 0 || !this.options.protection) return undefined;
    return this.options.protection.acquireLongPoll(this.options.project, identity.agentId);
  }

  private requireOperator(identity: Identity): void {
    if (!identity.operator) {
      throw new SynloqError("UNAUTHORIZED", "operator credential required");
    }
  }

  private async waitFor<T>(
    event: string,
    waitMs: number,
    response: ServerResponse,
    read: () => Promise<T> | T,
    complete: (value: T) => boolean,
  ): Promise<T> {
    const deadline = Date.now() + waitMs;

    while (true) {
      let notify!: () => void;
      const notified = new Promise<void>((resolve) => {
        notify = resolve;
      });
      const timer = setTimeout(notify, Math.max(0, deadline - Date.now()));
      this.events.on(event, notify);
      this.events.once(SHUTDOWN_EVENT, notify);
      response.once("close", notify);

      try {
        const value = await read();
        if (
          complete(value) ||
          waitMs === 0 ||
          this.closing ||
          response.destroyed ||
          Date.now() >= deadline
        ) {
          return value;
        }
        await notified;
        if (this.closing || response.destroyed || response.writableEnded) return value;
      } finally {
        clearTimeout(timer);
        this.events.off(event, notify);
        this.events.off(SHUTDOWN_EVENT, notify);
        response.off("close", notify);
      }
    }
  }

  private async readJson(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      size += buffer.byteLength;
      if (size <= MAX_JSON_BYTES) chunks.push(buffer);
    }
    if (size > MAX_JSON_BYTES) {
      throw new SynloqError("INVALID_INPUT", "JSON body exceeds the 64 KiB limit");
    }

    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      throw new SynloqError("INVALID_INPUT", "malformed JSON body");
    }
  }

  private sendError(response: ServerResponse, error: unknown, authentication: boolean): void {
    const mapped = this.mapError(error, authentication);
    this.sendJson(response, mapped.status, {
      error: { code: mapped.error.code, message: mapped.error.message },
    });
  }

  private mapError(error: unknown, authentication: boolean): ErrorResponse {
    if (error instanceof z.ZodError) {
      return {
        status: 400,
        error: new SynloqError("INVALID_INPUT", "request validation failed"),
      };
    }
    if (!(error instanceof SynloqError)) {
      return {
        status: 500,
        error: new SynloqError("STORAGE_FAILURE", "internal relay failure"),
      };
    }

    switch (error.code) {
      case "INVALID_INPUT":
        return { status: 400, error };
      case "UNAUTHORIZED":
        return { status: authentication ? 401 : 403, error };
      case "UNKNOWN_RECIPIENT":
      case "NOT_FOUND":
        return { status: 404, error };
      case "IDEMPOTENCY_CONFLICT":
      case "DUPLICATE_SESSION":
      case "INCOMPATIBLE_PROTOCOL":
      case "PAUSED":
      case "DELIVERY_UNCERTAIN":
        return { status: 409, error };
      case "RATE_LIMITED":
      case "QUEUE_FULL":
        return { status: 429, error };
      case "STORAGE_FAILURE":
      case "PERMISSION_DENIED":
        // A local filesystem condition of the relay host; the client cannot
        // fix it, so it stays a 500 — but with an explicit code and path.
        return { status: 500, error };
    }
  }

  private sendJson(response: ServerResponse, status: number, value: unknown): void {
    if (response.destroyed || response.writableEnded) return;
    const body = JSON.stringify(value);
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
    });
    response.end(body);
  }
}
