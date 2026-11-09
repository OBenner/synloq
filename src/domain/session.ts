export const PROTOCOL_VERSION = 1 as const;
export type SessionState = "idle" | "busy" | "closed" | "unknown";
export type DeliveryState = "stored" | "submitted" | "delivered" | "acked";

export interface AdapterCapabilities {
  activeDelivery: boolean;
  stateReporting: boolean;
  clientIdempotency: boolean;
}

export interface SessionRegistration {
  project: string;
  agentId: string;
  sessionId: string;
  protocolVersion: number;
  capabilities: AdapterCapabilities;
}

export interface AdapterSession extends SessionRegistration {
  state: SessionState;
  lastHeartbeatAt: string;
  stateObservedAt: string;
  leaseExpiresAt: string;
}
