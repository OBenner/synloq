import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "../config/atomic-file.js";
import { CredentialStore } from "../config/credentials.js";
import { loadManifestLanguage } from "../config/manifest.js";
import { projectPaths } from "../config/paths.js";
import { TeamStateStore } from "../config/team-state.js";
import type { Language } from "../i18n/index.js";
import { DEFAULT_RELAY_URL, roleRuntimeConfig } from "../init/runtime-config.js";

export interface RepairAction {
  agentId: string;
  token: "reused" | "reissued";
  config: "unchanged" | "rewritten" | "written";
}

export interface RepairResult {
  actions: RepairAction[];
}

interface ExistingChannelConfig {
  relayUrl?: unknown;
  language?: unknown;
}

const LANGUAGES: readonly string[] = ["en", "ru"];

/**
 * doctor --repair (issue #6): rebuild generated role-channel configs and
 * re-issue stale/missing token files from the saved team state, without a
 * full re-init. Idempotent: on a healthy setup every action is
 * reused/unchanged and no file is touched.
 */
export async function repairTeamConfigs(options: {
  projectRoot: string;
  synloqHome?: string;
}): Promise<RepairResult> {
  const paths = await projectPaths(options.projectRoot, options.synloqHome);
  const state = await new TeamStateStore(paths.bindings).read();
  if (!state) return { actions: [] };
  const language = await loadManifestLanguage(options.projectRoot);
  const credentials = new CredentialStore(options.projectRoot, paths.home);

  const actions: RepairAction[] = [];
  for (const [agentId, conversation] of Object.entries(state.conversations)) {
    if (conversation.kind === "opencode") continue;

    const credential = await credentials.ensureCredential(state.project, agentId);

    const configPath = join(paths.runtime, "mcp", `${agentId}.json`);
    const existing = await readExistingConfig(configPath);
    const expected = roleRuntimeConfig({
      // Preserve operator-set values when the existing config is readable;
      // otherwise fall back to the same defaults init uses.
      relayUrl: typeof existing?.relayUrl === "string" ? existing.relayUrl : DEFAULT_RELAY_URL,
      tokenPath: credential.tokenPath,
      synloqHome: paths.home,
      language: preservedLanguage(existing, language),
      projectRoot: state.projectRoot,
      agentId,
      binding: conversation,
    });
    const serialized = `${JSON.stringify(expected, null, 2)}\n`;
    const configAction =
      existing === undefined
        ? "written"
        : (await readFile(configPath, "utf8")) === serialized
          ? "unchanged"
          : "rewritten";
    if (configAction !== "unchanged") await writeJsonAtomic(configPath, expected);

    actions.push({
      agentId,
      token: credential.reused ? "reused" : "reissued",
      config: configAction,
    });
  }
  return { actions };
}

async function readExistingConfig(configPath: string): Promise<ExistingChannelConfig | undefined> {
  try {
    return JSON.parse(await readFile(configPath, "utf8")) as ExistingChannelConfig;
  } catch {
    return undefined;
  }
}

function preservedLanguage(
  existing: ExistingChannelConfig | undefined,
  fallback: Language,
): Language {
  return typeof existing?.language === "string" && LANGUAGES.includes(existing.language)
    ? (existing.language as Language)
    : fallback;
}
