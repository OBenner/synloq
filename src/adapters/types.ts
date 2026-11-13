import type { Message } from "../domain/message.js";
import {
  PROTOCOL_VERSION,
  type AdapterCapabilities,
  type AdapterSession,
  type SessionState,
} from "../domain/session.js";

export interface Clock {
  now(): number;
}

export interface DeliveryEvidence {
  sessionId: string;
  generation: number;
  project: string;
  from: string;
  messageId: string;
  threadId: string;
}

export interface DeliverySubmissionContext {
  generation: number;
  signal?: AbortSignal;
  /** Stored deliveries still queued behind this one, for wrapper hints. */
  pendingAfter?: number;
}

export interface DeliveryReceipt {
  state: "submitted" | "delivered";
  clientMessageId?: string;
  evidence?: DeliveryEvidence;
}

export interface DeliveryAdapter {
  readonly capabilities: AdapterCapabilities;
  state(sessionId: string): Promise<SessionState>;
  submit(
    sessionId: string,
    message: Message,
    context?: DeliverySubmissionContext,
  ): Promise<DeliveryReceipt>;
}

export function inactiveReason(
  session: AdapterSession | undefined,
  observedState: SessionState = session?.state ?? "unknown",
): string {
  if (!session) return "session-not-registered";
  if (session.protocolVersion !== PROTOCOL_VERSION) return "incompatible-protocol";
  if (!session.capabilities.activeDelivery) return "active-delivery-unsupported";
  if (!session.capabilities.stateReporting) return "state-reporting-unsupported";
  if (observedState !== "idle") return `session-${observedState}`;
  return "ready";
}
