import type { KimiWorkTeamConversation } from "../config/team-state.js";
import type { Language } from "../i18n/index.js";

export const DEFAULT_RELAY_URL = "http://127.0.0.1:4100";

/**
 * Paths under the Synloq home, rendered relative to a generated channel
 * config (<home>/runtime/<key>/mcp/<role>.json) — the stdio loader resolves
 * them against the config directory (issue #7). Shared by the Kimi Work and
 * OpenCode renderers so both stay relocation-safe (issue #32 W5).
 */
export function relativeHomePaths(
  projectKey: string,
  agentId: string,
): { credentialPath: string; synloqHome: string } {
  return {
    credentialPath: `../../../credentials/${projectKey}/${agentId}.token`,
    synloqHome: "../../..",
  };
}

export interface RoleRuntimeConfigInput {
  relayUrl: string;
  /** Project key — used to render the credential path relative to the config. */
  projectKey: string;
  language: Language;
  projectRoot: string;
  agentId: string;
  binding: KimiWorkTeamConversation;
}

/**
 * The generated MCP config for one Kimi Work role channel. Shared by
 * initialize-team (init) and doctor --repair so a repaired config is
 * byte-identical to what init would render (issue #6).
 *
 * Issue #7: paths under the Synloq home are rendered relative to the config
 * file location (<home>/runtime/<key>/mcp/<role>.json), so moving the home
 * directory keeps channels valid; the stdio loader resolves them against the
 * config directory. kimiWork.projectRoot stays absolute by nature — doctor
 * flags it when it stops resolving.
 */
export function roleRuntimeConfig(input: RoleRuntimeConfigInput): Record<string, unknown> {
  return {
    relayUrl: input.relayUrl,
    ...relativeHomePaths(input.projectKey, input.agentId),
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
