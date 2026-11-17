import { relative, resolve, sep } from "node:path";
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

/**
 * Renders an absolute target relative to the generated config's directory,
 * so moving the project root or the Synloq home keeps configs valid (the
 * stdio loader resolves relative paths against the config directory).
 * Falls back to the absolute path when no relative form exists — different
 * drive roots on Windows make path.relative return the absolute target.
 * Forward slashes keep the JSON portable across platforms.
 */
export function relativeConfigPath(configDir: string, target: string): string {
  const rendered = relative(resolve(configDir), resolve(target));
  if (rendered === "") return target;
  return rendered.split(sep).join("/");
}

export interface RoleRuntimeConfigInput {
  project: string;
  relayUrl: string;
  /** Project key — used to render the credential path relative to the config. */
  projectKey: string;
  language: Language;
  projectRoot: string;
  /** Directory the config is written to — anchors the relative projectRoot. */
  configDir: string;
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
 * config directory. kimiWork.projectRoot is rendered relative the same way
 * (UX hardening) with an absolute fallback across drive roots.
 */
export function roleRuntimeConfig(input: RoleRuntimeConfigInput): Record<string, unknown> {
  return {
    project: input.project,
    agentId: input.agentId,
    relayUrl: input.relayUrl,
    ...relativeHomePaths(input.projectKey, input.agentId),
    language: input.language,
    kimiWork: {
      projectRoot: relativeConfigPath(input.configDir, input.projectRoot),
      agentId: input.agentId,
      conversationKey: input.binding.conversationKey,
      workAgentId: input.binding.workAgentId,
      ...(input.binding.kernelSessionId ? { kernelSessionId: input.binding.kernelSessionId } : {}),
    },
  };
}
