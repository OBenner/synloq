import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeJsonAtomic } from "../config/atomic-file.js";
import { CredentialStore } from "../config/credentials.js";
import { mergeManifestParticipants, type ManifestRole } from "../config/manifest.js";
import { projectPaths } from "../config/paths.js";
import {
  TeamStateStore,
  type OpenCodeTeamConversation,
  type TeamState,
} from "../config/team-state.js";
import { SynloqError } from "../domain/errors.js";
import type { Language } from "../i18n/index.js";
import { mergeOpencodeMcpServers } from "../host/opencode/config-file.js";
import type { OpenCodeSessionHost } from "../host/opencode/client.js";
import { FileSecurityAuditLog, auditLogPath } from "../relay/audit-log.js";
import { isLoopbackHttpUrl } from "../transport/loopback.js";
import { parseRoleInputs, resolveLanguage } from "./initialize-team.js";
import { relativeConfigPath, relativeHomePaths } from "./runtime-config.js";
import { rolePromptOpenCode } from "./role-prompt.js";
import type { RoleInput } from "./types.js";

export interface InitializeOpenCodeTeamOptions {
  manifestParticipants?: ManifestRole[];
  projectRoot: string;
  project: string;
  roles: RoleInput[];
  synloqHome?: string;
  runtimeEntrypoint: string;
  relayUrl?: string;
  host?: OpenCodeSessionHost;
  language?: Language;
}

export interface InitializedOpenCodeRole {
  agentId: string;
  configPath: string;
  credentialPath: string;
  sessionId?: string;
  permissionsApplied?: boolean;
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

// OpenCode init (W1): manifest, credentials, legacy MCP configs, a
// non-destructive opencode.json merge, and — when a session host is
// supplied — one visible session per role via the OpenCode server API.
// Re-running reconciles: live sessions are kept, missing ones recreated.
export async function initializeOpenCodeTeam(
  options: InitializeOpenCodeTeamOptions,
): Promise<InitializeOpenCodeTeamResult> {
  const { project, roles } = parseRoleInputs(options.project, options.roles);
  if (!options.host && roles.some((role) => role.conversationKey !== undefined)) {
    throw new SynloqError("INVALID_INPUT", "--conversation requires a reachable OpenCode service");
  }
  const relayUrl = options.relayUrl ?? DEFAULT_RELAY_URL;
  if (!isLoopbackHttpUrl(relayUrl)) {
    throw new SynloqError("INVALID_INPUT", "relayUrl must be an explicit HTTP loopback origin");
  }
  const projectRoot = await realpath(options.projectRoot);
  const language = await resolveLanguage(projectRoot, options.language);

  const paths = await projectPaths(projectRoot, options.synloqHome);
  const stateStore = new TeamStateStore(paths.bindings);
  let state = await stateStore.read();
  if (state && (state.project !== project || state.projectRoot !== projectRoot)) {
    throw new SynloqError("INVALID_INPUT", "Synloq project state ownership does not match");
  }

  const participants: ManifestRole[] = roles.map((role) => ({
    project,
    agentId: role.agentId,
    title: role.title,
    role: role.role,
    host: role.host ?? "opencode",
  }));
  // Issue #32 (gaps G1/G3): merge into the existing manifest instead of
  // overwriting it, and build the deny-tools matrix from the merged roster —
  // a single-role run must not leave the new session able to call the tools
  // of roles that were not part of this invocation.
  const roster = await mergeManifestParticipants(
    projectRoot,
    options.manifestParticipants ?? participants,
    language,
  );
  const credentials = new CredentialStore(
    projectRoot,
    paths.home,
    new FileSecurityAuditLog(auditLogPath(paths.home, paths.key)),
  );
  await credentials.ensureCredential(project, "operator");

  const host = options.host;
  const initializedRoles: InitializedOpenCodeRole[] = [];
  const servers: Record<string, { type: "local"; command: string[]; enabled: boolean }> = {};
  for (const role of roles) {
    const credential = await credentials.ensureCredential(project, role.agentId);
    const configPath = join(paths.runtime, "mcp", `${role.agentId}.json`);
    servers[`synloq-${role.agentId}`] = {
      type: "local",
      command: ["node", options.runtimeEntrypoint, configPath],
      enabled: true,
    };
    const initialized: InitializedOpenCodeRole = {
      agentId: role.agentId,
      configPath,
      credentialPath: credential.tokenPath,
    };

    let boundSessionId: string | undefined;
    if (host) {
      const existing = state?.conversations[role.agentId];
      if (existing && existing.kind !== "opencode") {
        throw new SynloqError(
          "INVALID_INPUT",
          `role ${role.agentId} is already bound to a Kimi Work conversation`,
        );
      }
      let sessionId: string | undefined;
      let permissionsApplied: boolean | undefined;
      if (existing && (await host.getSession(existing.sessionId))) {
        sessionId = existing.sessionId;
      } else if (role.conversationKey) {
        if (!(await host.getSession(role.conversationKey))) {
          throw new SynloqError(
            "INVALID_INPUT",
            `OpenCode session ${role.conversationKey} does not exist`,
          );
        }
        sessionId = role.conversationKey;
      } else {
        const denyTools = roster
          .filter((other) => other.agentId !== role.agentId)
          .map((other) => `synloq-${other.agentId}*`);
        const created = await host.createSession({
          title: role.title,
          directory: projectRoot,
          denyTools,
        });
        sessionId = created.id;
        permissionsApplied = created.permissionsApplied;
        await host.postPrompt(sessionId, rolePromptOpenCode(role, language));
      }
      const conversation: OpenCodeTeamConversation = {
        kind: "opencode",
        agentId: role.agentId,
        sessionId,
        directory: projectRoot,
      };
      state = await stateStore.update((current): TeamState => {
        const base: TeamState = current ?? {
          version: 1,
          project,
          projectRoot,
          conversations: {},
        };
        return {
          ...base,
          project,
          projectRoot,
          conversations: { ...base.conversations, [role.agentId]: conversation },
        };
      });
      initialized.sessionId = sessionId;
      if (permissionsApplied !== undefined) initialized.permissionsApplied = permissionsApplied;
      boundSessionId = sessionId;
    }
    // The opencode binding lets the MCP channel host the relay itself
    // (supervisor election), so no manual `synloq serve` is needed (#30).
    // sessionId is absent only when init ran without a reachable service.
    // Paths under the Synloq home are relative to the config file (#7/#32);
    // projectRoot is relative the same way, with an absolute fallback.
    await writeJsonAtomic(configPath, {
      relayUrl,
      ...relativeHomePaths(paths.key, role.agentId),
      language,
      opencode: {
        projectRoot: relativeConfigPath(dirname(configPath), projectRoot),
        agentId: role.agentId,
        ...(boundSessionId ? { sessionId: boundSessionId } : {}),
      },
    });
    initializedRoles.push(initialized);
  }

  const opencodeConfigPath = await mergeOpencodeMcpServers(projectRoot, servers);

  if (!host) {
    await stateStore.update((current): TeamState => {
      const base: TeamState = current ?? {
        version: 1,
        project,
        projectRoot,
        conversations: {},
      };
      return { ...base, project, projectRoot };
    });
  }

  return {
    project,
    manifestPath: join(projectRoot, "synloq.yaml"),
    statePath: paths.bindings,
    opencodeConfigPath,
    registrationRequired: true,
    roles: initializedRoles,
  };
}
