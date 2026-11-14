import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "../config/atomic-file.js";
import { CredentialStore } from "../config/credentials.js";
import { writeManifest } from "../config/manifest.js";
import { projectPaths } from "../config/paths.js";
import { TeamStateStore, type TeamState } from "../config/team-state.js";
import { SynloqError } from "../domain/errors.js";
import type { Participant } from "../domain/message.js";
import type { Language } from "../i18n/index.js";
import { isLoopbackHttpUrl } from "../transport/loopback.js";
import { parseRoleInputs, resolveLanguage } from "./initialize-team.js";
import type { RoleInput } from "./types.js";

export interface InitializeGenericTeamOptions {
  projectRoot: string;
  project: string;
  roles: RoleInput[];
  synloqHome?: string;
  relayUrl?: string;
  language?: Language;
}

export interface InitializedGenericRole {
  agentId: string;
  configPath: string;
  credentialPath: string;
}

export interface InitializeGenericTeamResult {
  project: string;
  manifestPath: string;
  statePath: string;
  registrationRequired: boolean;
  roles: InitializedGenericRole[];
}

const DEFAULT_RELAY_URL = "http://127.0.0.1:4100";

// Generic init: manifest, credentials, runtime MCP configs, and team state —
// no host sessions, no host config files. Used for hosts Synloq has no
// adapter for (the MCP inbox profile): the operator wires each role's
// configPath into the host manually. Re-running is idempotent: credentials
// and team state are preserved and the configs are rewritten unchanged.
export async function initializeGenericTeam(
  options: InitializeGenericTeamOptions,
): Promise<InitializeGenericTeamResult> {
  const { project, roles } = parseRoleInputs(options.project, options.roles);
  if (roles.some((role) => role.conversationKey !== undefined)) {
    throw new SynloqError(
      "INVALID_INPUT",
      "--conversation requires a host adapter; generic init manages no host sessions",
    );
  }
  const relayUrl = options.relayUrl ?? DEFAULT_RELAY_URL;
  if (!isLoopbackHttpUrl(relayUrl)) {
    throw new SynloqError("INVALID_INPUT", "relayUrl must be an explicit HTTP loopback origin");
  }
  const projectRoot = await realpath(options.projectRoot);
  const language = await resolveLanguage(projectRoot, options.language);

  const paths = await projectPaths(projectRoot, options.synloqHome);
  const stateStore = new TeamStateStore(paths.bindings);
  const state = await stateStore.read();
  if (state && (state.project !== project || state.projectRoot !== projectRoot)) {
    throw new SynloqError("INVALID_INPUT", "Synloq project state ownership does not match");
  }
  if (state && Object.keys(state.conversations).length > 0) {
    throw new SynloqError(
      "INVALID_INPUT",
      "roles are already bound to host sessions; re-initialize with their host (--host kimi-work|opencode)",
    );
  }

  const participants: Participant[] = roles.map((role) => ({
    project,
    agentId: role.agentId,
    title: role.title,
    role: role.role,
  }));
  await writeManifest(projectRoot, participants, language);
  const credentials = new CredentialStore(projectRoot, paths.home);
  await credentials.ensureCredential(project, "operator");

  const initializedRoles: InitializedGenericRole[] = [];
  for (const role of roles) {
    const credential = await credentials.ensureCredential(project, role.agentId);
    const configPath = join(paths.runtime, "mcp", `${role.agentId}.json`);
    await writeJsonAtomic(configPath, {
      relayUrl,
      credentialPath: credential.tokenPath,
      language,
    });
    initializedRoles.push({
      agentId: role.agentId,
      configPath,
      credentialPath: credential.tokenPath,
    });
  }

  await stateStore.update((current): TeamState => {
    const base: TeamState = current ?? {
      version: 1,
      project,
      projectRoot,
      conversations: {},
    };
    return { ...base, project, projectRoot };
  });

  return {
    project,
    manifestPath: join(projectRoot, "synloq.yaml"),
    statePath: paths.bindings,
    registrationRequired: false,
    roles: initializedRoles,
  };
}
