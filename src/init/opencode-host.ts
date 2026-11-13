import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "../config/atomic-file.js";
import { CredentialStore } from "../config/credentials.js";
import { writeManifest } from "../config/manifest.js";
import { projectPaths } from "../config/paths.js";
import { TeamStateStore, type TeamState } from "../config/team-state.js";
import { SynloqError } from "../domain/errors.js";
import type { Participant } from "../domain/message.js";
import { mergeOpencodeMcpServers } from "../host/opencode/config-file.js";
import { isLoopbackHttpUrl } from "../transport/loopback.js";
import { parseRoleInputs } from "./initialize-team.js";
import type { RoleInput } from "./types.js";

export interface InitializeOpenCodeTeamOptions {
  projectRoot: string;
  project: string;
  roles: RoleInput[];
  synloqHome?: string;
  runtimeEntrypoint: string;
  relayUrl?: string;
}

export interface InitializedOpenCodeRole {
  agentId: string;
  configPath: string;
  credentialPath: string;
}

export interface InitializeOpenCodeTeamResult {
  project: string;
  manifestPath: string;
  statePath: string;
  opencodeConfigPath: string;
  registrationRequired: boolean;
  roles: InitializedOpenCodeRole[];
}

const DEFAULT_RELAY_URL = "http://127.0.0.1:4100";

// OpenCode init (W1a): manifest, credentials, legacy MCP configs and a
// non-destructive opencode.json merge. Visible sessions (team-state
// conversations) land with W1b; existing conversation entries are preserved
// so re-running init after sessions exist stays a no-op for them.
export async function initializeOpenCodeTeam(
  options: InitializeOpenCodeTeamOptions,
): Promise<InitializeOpenCodeTeamResult> {
  const { project, roles } = parseRoleInputs(options.project, options.roles);
  if (roles.some((role) => role.conversationKey !== undefined)) {
    throw new SynloqError(
      "INVALID_INPUT",
      "--conversation is not supported for the opencode host yet",
    );
  }
  const relayUrl = options.relayUrl ?? DEFAULT_RELAY_URL;
  if (!isLoopbackHttpUrl(relayUrl)) {
    throw new SynloqError("INVALID_INPUT", "relayUrl must be an explicit HTTP loopback origin");
  }
  const projectRoot = await realpath(options.projectRoot);

  const paths = await projectPaths(projectRoot, options.synloqHome);
  const stateStore = new TeamStateStore(paths.bindings);
  const state = await stateStore.read();
  if (state && (state.project !== project || state.projectRoot !== projectRoot)) {
    throw new SynloqError("INVALID_INPUT", "Synloq project state ownership does not match");
  }

  const participants: Participant[] = roles.map((role) => ({
    project,
    agentId: role.agentId,
    title: role.title,
    role: role.role,
  }));
  await writeManifest(projectRoot, participants);
  const credentials = new CredentialStore(projectRoot, paths.home);
  await credentials.ensureCredential(project, "operator");

  const initializedRoles: InitializedOpenCodeRole[] = [];
  const servers: Record<string, { type: "local"; command: string[]; enabled: boolean }> = {};
  for (const role of roles) {
    const credential = await credentials.ensureCredential(project, role.agentId);
    const configPath = join(paths.runtime, "mcp", `${role.agentId}.json`);
    await writeJsonAtomic(configPath, {
      relayUrl,
      credentialPath: credential.tokenPath,
    });
    servers[`synloq-${role.agentId}`] = {
      type: "local",
      command: ["node", options.runtimeEntrypoint, configPath],
      enabled: true,
    };
    initializedRoles.push({
      agentId: role.agentId,
      configPath,
      credentialPath: credential.tokenPath,
    });
  }

  const opencodeConfigPath = await mergeOpencodeMcpServers(projectRoot, servers);

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
    opencodeConfigPath,
    registrationRequired: true,
    roles: initializedRoles,
  };
}
