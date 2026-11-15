import { z } from "zod";

export const hostSchema = z.enum(["kimi-work", "opencode", "codex-desktop", "zcode", "generic"]);
export type HostName = z.infer<typeof hostSchema>;

export const HOST_CAPABILITIES: Record<HostName, { canProvisionSessions: boolean }> = {
  "kimi-work": { canProvisionSessions: true },
  opencode: { canProvisionSessions: true },
  "codex-desktop": { canProvisionSessions: false },
  zcode: { canProvisionSessions: false },
  generic: { canProvisionSessions: false },
};
