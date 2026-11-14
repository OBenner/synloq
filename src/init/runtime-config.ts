import type { KimiWorkTeamConversation } from "../config/team-state.js";
import type { Language } from "../i18n/index.js";

export const DEFAULT_RELAY_URL = "http://127.0.0.1:4100";

export interface RoleRuntimeConfigInput {
  relayUrl: string;
  tokenPath: string;
  synloqHome: string;
  language: Language;
  projectRoot: string;
  agentId: string;
  binding: KimiWorkTeamConversation;
}

/**
 * The generated MCP config for one Kimi Work role channel. Shared by
 * initialize-team (init) and doctor --repair so a repaired config is
 * byte-identical to what init would render (issue #6).
 */
export function roleRuntimeConfig(input: RoleRuntimeConfigInput): Record<string, unknown> {
  return {
    relayUrl: input.relayUrl,
    credentialPath: input.tokenPath,
    synloqHome: input.synloqHome,
    language: input.language,
    kimiWork: {
      projectRoot: input.projectRoot,
      agentId: input.agentId,
      conversationKey: input.binding.conversationKey,
      workAgentId: input.binding.workAgentId,
      ...(input.binding.kernelSessionId ? { kernelSessionId: input.binding.kernelSessionId } : {}),
    },
  };
}
