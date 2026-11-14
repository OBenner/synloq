import { z } from "zod";
import type { DeliveryReceipt } from "../adapters/types.js";
import { SynloqError } from "../domain/errors.js";
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
import { parseLoopbackHttpUrl } from "./loopback.js";

const errorCodes = [
  "INVALID_INPUT",
  "UNKNOWN_RECIPIENT",
  "IDEMPOTENCY_CONFLICT",
  "DUPLICATE_SESSION",
  "INCOMPATIBLE_PROTOCOL",
  "RATE_LIMITED",
  "QUEUE_FULL",
  "PAUSED",
  "STORAGE_FAILURE",
  "PERMISSION_DENIED",
  "UNAUTHORIZED",
  "DELIVERY_UNCERTAIN",
  "NOT_FOUND",
] as const;
const errorResponseSchema = z.object({
  error: z.object({ code: z.enum(errorCodes), message: z.string() }),
});

export type TokenProvider = () => string | Promise<string>;
export type SessionRegistrationRequest = Omit<SessionRegistration, "project" | "agentId">;
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

  constructor(
    baseUrl: string,
    private readonly tokenProvider: TokenProvider,
  ) {
    // Fail closed: credentials must never leave an explicit loopback origin.
    this.baseUrl = parseLoopbackHttpUrl(baseUrl).baseUrl;
  }

  async health(timeoutMs = 5_000): Promise<{ service: string; protocolVersion: number }> {
    // Unauthenticated compatibility probe: the bearer token is only sent after
    // this endpoint confirms a Synloq relay is listening.
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/health`, {
        method: "GET",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") throw unavailable();
      throw error;
    }
    if (!response.ok) throw unavailable();
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw unavailable();
    }
    const parsed = healthResponseSchema.safeParse(payload);
    if (!parsed.success) throw unavailable();
    return parsed.data;
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

  acknowledge(messageId: string): Promise<{ message: Message }> {
    return this.request("POST", "/v1/ack", { messageId });
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

  doctor(): Promise<{ sessions: AdapterSession[] }> {
    return this.request("GET", "/v1/operator/doctor");
  }

  private longPollTimeout(waitMs: number | undefined): number {
    return waitMs !== undefined && waitMs > 0 ? waitMs + 5_000 : 5_000;
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    timeoutMs = 5_000,
    externalSignal?: AbortSignal,
  ): Promise<T> {
    const token = await this.tokenProvider();
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: externalSignal ? AbortSignal.any([timeoutSignal, externalSignal]) : timeoutSignal,
    });
    const text = await response.text();
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
