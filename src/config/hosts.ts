import { z } from "zod";

export const hostSchema = z.enum(["kimi-work", "opencode", "codex-desktop", "zcode", "generic"]);
export type HostName = z.infer<typeof hostSchema>;

export interface HostCapabilities {
  /** The host API can create/bind sessions for roles. */
  canProvisionSessions: boolean;
  /** The host API can push a notice into a live chat (ADR-0005 matrix). */
  hasPush: boolean;
}

export const HOST_CAPABILITIES: Record<HostName, HostCapabilities> = {
  "kimi-work": { canProvisionSessions: true, hasPush: true },
  opencode: { canProvisionSessions: true, hasPush: true },
  "codex-desktop": { canProvisionSessions: false, hasPush: false },
  zcode: { canProvisionSessions: false, hasPush: false },
  generic: { canProvisionSessions: false, hasPush: false },
};
