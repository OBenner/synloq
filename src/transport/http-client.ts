import { z } from "zod";
import type { DeliveryReceipt } from "../adapters/types.js";
import { SynloqError } from "../domain/errors.js";
import type { Message, Participant } from "../domain/message.js";
import type { AdapterSession, SessionRegistration, SessionState } from "../domain/session.js";
import type { InboxResult, ReplyRequest, SendRequest } from "../relay/relay-service.js";
import type { PauseScope } from "../storage/message-store.js";

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
}

export interface WaitOptions {
  waitMs?: number;
  signal?: AbortSignal;
}

export interface DeliveryFailureRequest {
  sessionId: string;
  code: "RETRYABLE" | "DELIVERY_UNCERTAIN";
  clientIdempotency: boolean;
}

export interface HeartbeatRequest {
  sessionId: string;
  state: SessionState;
}

export interface CloseSessionRequest {
  sessionId: string;
}

export interface PauseRequest {
  scope: PauseScope;
  scopeId: string;
}

export class RelayHttpClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly tokenProvider: TokenProvider,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  listParticipants(): Promise<{ participants: Participant[] }> {
    return this.request("GET", "/v1/participants");
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

  registerSession(input: SessionRegistrationRequest): Promise<{ session: AdapterSession }> {
    return this.request("POST", "/v1/sessions/register", input);
  }

  heartbeat(input: HeartbeatRequest): Promise<{ session: AdapterSession }> {
    return this.request("POST", "/v1/sessions/heartbeat", input);
  }

  closeSession(input: CloseSessionRequest): Promise<{ session: AdapterSession }> {
    return this.request("POST", "/v1/sessions/close", input);
  }

  nextDelivery(options: WaitOptions = {}): Promise<{ message: Message | null }> {
    const suffix = options.waitMs === undefined ? "" : `?waitMs=${options.waitMs}`;
    return this.request(
      "GET",
      `/v1/deliveries/next${suffix}`,
      undefined,
      this.longPollTimeout(options.waitMs),
      options.signal,
    );
  }

  receipt(messageId: string, receipt: DeliveryReceipt): Promise<{ message: Message }> {
    return this.request("POST", `/v1/deliveries/${encodeURIComponent(messageId)}/receipt`, receipt);
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
