import { z } from "zod";
import type { DeliveryReceipt } from "../adapters/types.js";
import { SynloqError } from "../domain/errors.js";
import { relayConnectionError } from "./connection-error.js";
import type { Message, Participant } from "../domain/message.js";
import type {
  AdapterSession,
  SessionBinding,
  SessionRegistration,
  SessionState,
} from "../domain/session.js";
import type { InboxResult, ReplyRequest, SendRequest } from "../relay/relay-service.js";
import { PROTOCOL_VERSION } from "../domain/session.js";
import type { ClaimedDelivery, PauseScope } from "../storage/message-store.js";
import type { Note } from "../storage/notes-store.js";
import { parseLoopbackHttpUrl } from "./loopback.js";
import {
  AUTH_VERSION,
  challengeSchema,
  challengeProof,
  equalProof,
  hash,
  keyId,
  newNonce,
  requestDigest,
  requestProof,
  responseProof,
  type AuthContext,
  type Challenge,
} from "./auth-proof.js";

const errorCodes = [
  "INVALID_INPUT",
  "UNKNOWN_RECIPIENT",
  "UNKNOWN_SENDER",
  "SENDER_RESERVED",
  "IDEMPOTENCY_CONFLICT",
  "DUPLICATE_SESSION",
  "INCOMPATIBLE_PROTOCOL",
  "RATE_LIMITED",
  "QUEUE_FULL",
  "PAUSED",
  "STORAGE_FAILURE",
  "PERMISSION_DENIED",
  "ALREADY_RUNNING",
  "UNAUTHORIZED",
  "DELIVERY_UNCERTAIN",
  "NOT_FOUND",
  "NOT_WRITER",
] as const;
const errorResponseSchema = z.object({
  error: z.object({ code: z.enum(errorCodes), message: z.string() }),
});

export type TokenProvider = () => string | Promise<string>;
export type SessionRegistrationRequest = Omit<SessionRegistration, "project" | "agentId"> & {
  ownership?: "exclusive";
  /** Client surface name ("kimi-work", "opencode", …); audit-only, never stored (issue #53). */
  surface?: string;
};
export type ReplaceSessionRequest = Omit<SessionRegistration, "project">;

export interface InboxOptions {
  cursor?: string;
  limit?: number;
  waitMs?: number;
  unread?: boolean;
}

export interface WaitOptions {
  waitMs?: number;
  signal?: AbortSignal;
}

export interface DeliveryFailureRequest extends SessionBinding {
  code: "RETRYABLE" | "DELIVERY_UNCERTAIN";
  clientIdempotency: boolean;
}

export interface HeartbeatRequest {
  sessionId: string;
  state: SessionState;
  generation?: number;
}

export interface CloseSessionRequest {
  sessionId: string;
  generation?: number;
}

export interface PauseRequest {
  scope: PauseScope;
  scopeId: string;
}

const healthResponseSchema = z.object({
  service: z.literal("synloq-relay"),
  protocolVersion: z.literal(PROTOCOL_VERSION),
});

function unavailable(): SynloqError {
  return new SynloqError("STORAGE_FAILURE", "Synloq relay endpoint is unavailable or incompatible");
}

export class RelayHttpClient {
  private readonly baseUrl: string;

  private async fetch(url: string, options: RequestInit): Promise<Response> {
    try {
      return await fetch(url, options);
    } catch (error) {
      if (options.signal?.aborted || (error instanceof Error && error.name === "AbortError"))
        throw error;
      throw relayConnectionError(error);
    }
  }

  constructor(
    baseUrl: string,
    private readonly tokenProvider: TokenProvider,
    private readonly context: AuthContext,
  ) {
    // Fail closed: credentials must never leave an explicit loopback origin.
    this.baseUrl = parseLoopbackHttpUrl(baseUrl).baseUrl;
    if (!context?.project || !context.agentId)
      throw new SynloqError("INVALID_INPUT", "trusted project and role context required");
  }

  async health(timeoutMs = 5_000): Promise<{ service: string; protocolVersion: number }> {
    return healthResponseSchema.parse(
      await this.request("GET", "/v1/auth/health", undefined, timeoutMs),
    );
  }

  private async bytes(response: Response, limit: number): Promise<Buffer> {
    const reader = response.body?.getReader();
    if (!reader) return Buffer.alloc(0);
    const parts: Buffer[] = [];
    let length = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.length;
        if (length > limit) {
          await reader.cancel();
          throw unavailable();
        }
        parts.push(Buffer.from(chunk.value));
      }
      return Buffer.concat(parts);
    } finally {
      reader.releaseLock();
    }
  }

  private async challenge(
    token: string,
    signal: AbortSignal,
  ): Promise<{ challenge: Challenge; verifier: string }> {
    const verifier = hash(token);
    const kid = keyId(verifier, this.context);
    const clientNonce = newNonce();
    const response = await this.fetch(`${this.baseUrl}/v1/auth/challenge`, {
      method: "POST",
      redirect: "error",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        authVersion: AUTH_VERSION,
        project: this.context.project,
        kid,
        clientNonce,
      }),
    });
    // Status is only a failure hint, never authentication evidence or trusted text.
    // Preserve UNAUTHORIZED so token-file reload/recovery can run after rotation.
    if (!response.ok) {
      // Unauthenticated bodies are neither needed nor trusted. Cancel rather
      // than leaving an unbounded stream/socket alive during repeated failures.
      await response.body?.cancel();
      if (response.status === 401)
        throw new SynloqError("UNAUTHORIZED", "relay authentication rejected");
      throw new SynloqError(
        "INCOMPATIBLE_PROTOCOL",
        "relay authentication unavailable; auth v2 required",
      );
    }
    let parsed: ReturnType<typeof challengeSchema.safeParse>;
    try {
      parsed = challengeSchema.safeParse(
        JSON.parse((await this.bytes(response, 4096)).toString("utf8")),
      );
    } catch {
      throw unavailable();
    }
    if (!parsed.success) throw unavailable();
    const challenge = parsed.data;
    if (
      challenge.project !== this.context.project ||
      challenge.agentId !== this.context.agentId ||
      challenge.kid !== kid ||
      challenge.clientNonce !== clientNonce ||
      challenge.expiresAt <= Date.now() ||
      !equalProof(challenge.proof, challengeProof(verifier, challenge))
    ) {
      throw new SynloqError("UNAUTHORIZED", "invalid_relay_proof");
    }
    return { challenge, verifier };
  }

  listParticipants(timeoutMs = 5_000): Promise<{ participants: Participant[] }> {
    return this.request("GET", "/v1/participants", undefined, timeoutMs);
  }

  send(input: SendRequest): Promise<{ message: Message }> {
    return this.request("POST", "/v1/messages", input);
  }

  reply(input: ReplyRequest): Promise<{ message: Message }> {
    return this.request("POST", "/v1/replies", input);
  }

  inbox(options: InboxOptions = {}): Promise<InboxResult> {
    const query = new URLSearchParams();
    if (options.cursor !== undefined) query.set("cursor", options.cursor);
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    if (options.waitMs !== undefined) query.set("waitMs", String(options.waitMs));
    if (options.unread) query.set("unread", "1");
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return this.request(
      "GET",
      `/v1/inbox${suffix}`,
      undefined,
      this.longPollTimeout(options.waitMs),
    );
  }

  acknowledge(messageId: string, sessionId?: string): Promise<{ message: Message }> {
    return this.request("POST", "/v1/ack", {
      messageId,
      ...(sessionId === undefined ? {} : { sessionId }),
    });
  }

  registerSession(
    input: SessionRegistrationRequest,
    timeoutMs?: number,
  ): Promise<{ session: AdapterSession }> {
    return this.request("POST", "/v1/sessions/register", input, timeoutMs);
  }

  heartbeat(input: HeartbeatRequest, timeoutMs?: number): Promise<{ session: AdapterSession }> {
    return this.request("POST", "/v1/sessions/heartbeat", input, timeoutMs);
  }

  closeSession(input: CloseSessionRequest): Promise<{ session: AdapterSession }> {
    return this.request("POST", "/v1/sessions/close", input);
  }

  nextDelivery(
    options: WaitOptions & SessionBinding,
  ): Promise<ClaimedDelivery | ({ message: null } & SessionBinding)> {
    const query = new URLSearchParams({
      sessionId: options.sessionId,
      generation: String(options.generation),
    });
    if (options.waitMs !== undefined) query.set("waitMs", String(options.waitMs));
    return this.request(
      "GET",
      `/v1/deliveries/next?${query.toString()}`,
      undefined,
      this.longPollTimeout(options.waitMs),
      options.signal,
    );
  }

  authorizeDelivery(messageId: string, binding: SessionBinding): Promise<{ message: Message }> {
    return this.request(
      "POST",
      `/v1/deliveries/${encodeURIComponent(messageId)}/authorize`,
      binding,
    );
  }

  receipt(
    messageId: string,
    receipt: DeliveryReceipt,
    binding: SessionBinding,
  ): Promise<{ message: Message }> {
    return this.request("POST", `/v1/deliveries/${encodeURIComponent(messageId)}/receipt`, {
      ...receipt,
      ...binding,
    });
  }

  deliveryFailure(messageId: string, input: DeliveryFailureRequest): Promise<{ message: Message }> {
    return this.request("POST", `/v1/deliveries/${encodeURIComponent(messageId)}/failure`, input);
  }

  pause(input: PauseRequest): Promise<{ ok: true }> {
    return this.request("POST", "/v1/operator/pause", input);
  }

  resume(input: PauseRequest): Promise<{ ok: true }> {
    return this.request("POST", "/v1/operator/resume", input);
  }

  replaceSession(input: ReplaceSessionRequest): Promise<{ session: AdapterSession }> {
    return this.request("POST", "/v1/operator/replace-session", input);
  }

  doctor(): Promise<{
    sessions: AdapterSession[];
    notes?: { roles: number; notes: number; oldest?: string; newest?: string };
  }> {
    return this.request("GET", "/v1/operator/doctor");
  }

  noteRead(key: string): Promise<{ note: Note }> {
    return this.request("GET", `/v1/notes?${new URLSearchParams({ key })}`);
  }

  noteWrite(key: string, body: string): Promise<{ note: Note }> {
    return this.request("PUT", "/v1/notes", { key, body });
  }

  private longPollTimeout(waitMs: number | undefined): number {
    return waitMs !== undefined && waitMs > 0 ? waitMs + 5_000 : 5_000;
  }

  private async request<T>(
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: unknown,
    timeoutMs = 5_000,
    externalSignal?: AbortSignal,
  ): Promise<T> {
    const token = await this.tokenProvider();
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = externalSignal
      ? AbortSignal.any([timeoutSignal, externalSignal])
      : timeoutSignal;
    const { challenge, verifier } = await this.challenge(token, signal);
    const bytes = Buffer.from(body === undefined ? "" : JSON.stringify(body));
    const requestHash = requestDigest(challenge, method, path, bytes);
    const headers: Record<string, string> = {
      "x-synloq-auth-version": String(AUTH_VERSION),
      "x-synloq-challenge": challenge.serverNonce,
      "x-synloq-proof": requestProof(verifier, challenge, requestHash),
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      redirect: "error",
      headers,
      ...(body === undefined ? {} : { body: bytes }),
      signal,
    });
    const received = await this.bytes(response, 8 * 1024 * 1024);
    if (
      !equalProof(
        response.headers.get("x-synloq-proof") ?? "",
        responseProof(verifier, challenge, requestHash, response.status, received),
      )
    ) {
      throw new SynloqError("UNAUTHORIZED", "invalid_relay_response_proof");
    }
    const text = received.toString("utf8");
    let payload: unknown;
    try {
      payload = text === "" ? undefined : JSON.parse(text);
    } catch {
      throw new SynloqError("STORAGE_FAILURE", "relay returned malformed JSON");
    }

    if (!response.ok) {
      const parsed = errorResponseSchema.safeParse(payload);
      if (parsed.success) {
        throw new SynloqError(parsed.data.error.code, parsed.data.error.message);
      }
      throw new SynloqError(
        "STORAGE_FAILURE",
        `relay request failed with HTTP status ${response.status}`,
      );
    }
    return payload as T;
  }
}
