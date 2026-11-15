import { realpath } from "node:fs/promises";
import { HOST_CAPABILITIES, type HostName } from "../config/hosts.js";
import { projectPaths } from "../config/paths.js";
import { TeamStateStore } from "../config/team-state.js";
import { SynloqError } from "../domain/errors.js";
import type { OpenCodeSessionHost } from "../host/opencode/client.js";
import { isLoopbackHttpUrl } from "../transport/loopback.js";
import { initializeGenericTeam, type InitializedGenericRole } from "./generic-host.js";
import { initializeTeam, parseRoleInputs, resolveLanguage } from "./initialize-team.js";
import { initializeOpenCodeTeam } from "./opencode-host.js";
import { coreRules } from "./role-prompt.js";
import { DEFAULT_RELAY_URL } from "./runtime-config.js";
import { provisionDesktopRoles } from "./codex-desktop.js";
import type { InitializeTeamOptions, KimiWorkInitHost } from "./types.js";

export type ReconcileOptions = Omit<InitializeTeamOptions, "host" | "pluginSourcePath"> & {
  pluginSourcePath?: string;
};
export interface ReconcileDependencies {
  kimiWorkHost: () => Promise<KimiWorkInitHost>;
  openCodeHost: () => Promise<OpenCodeSessionHost>;
}

/** Reconcile host groups against one desired roster; never silently rebind a role. */
export async function reconcileTeam(
  options: ReconcileOptions,
  dependencies: ReconcileDependencies,
) {
  const { project, roles: parsed } = parseRoleInputs(options.project, options.roles);
  const roles = parsed.map((role) => ({ ...role, host: role.host ?? ("kimi-work" as HostName) }));
  const projectRoot = await realpath(options.projectRoot);
  const language = await resolveLanguage(projectRoot, options.language);
  const relayUrl = options.relayUrl ?? DEFAULT_RELAY_URL;
  if (!isLoopbackHttpUrl(relayUrl))
    throw new SynloqError("INVALID_INPUT", "relayUrl must be an explicit HTTP loopback origin");
  const paths = await projectPaths(projectRoot, options.synloqHome);
  const store = new TeamStateStore(paths.bindings);
  const state = await store.read();
  if (state && (state.project !== project || state.projectRoot !== projectRoot)) {
    throw new SynloqError("INVALID_INPUT", "Synloq project state ownership does not match");
  }
  for (const role of roles) {
    const binding = state?.conversations[role.agentId];
    const boundHost = binding ? (binding.kind ?? "kimi-work") : undefined;
    const previousHost = [boundHost, state?.placements?.[role.agentId]?.host].find(
      (host) => host !== undefined && host !== role.host,
    );
    if (previousHost) {
      throw new SynloqError(
        "INVALID_INPUT",
        `role ${role.agentId} is prepared for ${previousHost}; use explicit operator replace-session/migration before changing host`,
      );
    }
    if (!HOST_CAPABILITIES[role.host].canProvisionSessions && role.conversationKey) {
      throw new SynloqError("INVALID_INPUT", `--conversation is unsupported for ${role.host}`);
    }
  }
  const kimiRoles = roles.filter((role) => role.host === "kimi-work");
  if (kimiRoles.length && !options.pluginSourcePath)
    throw new SynloqError("INVALID_INPUT", "Kimi Work requires a plugin source path");
  const manifestParticipants = roles.map(({ agentId, title, role, host }) => ({
    project,
    agentId,
    title,
    role,
    host,
  }));
  const common = {
    project,
    projectRoot,
    synloqHome: paths.home,
    language,
    relayUrl,
    manifestParticipants,
  };
  let kimi;
  if (kimiRoles.length) {
    const host = await dependencies.kimiWorkHost();
    try {
      kimi = await initializeTeam({
        ...common,
        roles: kimiRoles,
        host,
        pluginSourcePath: options.pluginSourcePath!,
        runtimeEntrypoint: options.runtimeEntrypoint,
      });
    } finally {
      await host.close?.();
    }
  }
  let opencode;
  const openCodeRoles = roles.filter((role) => role.host === "opencode");
  if (openCodeRoles.length) {
    const host = await dependencies.openCodeHost();
    opencode = await initializeOpenCodeTeam({
      ...common,
      roles: openCodeRoles,
      host,
      runtimeEntrypoint: options.runtimeEntrypoint,
    });
  }
  const desktopRoles = roles.filter((role) => role.host === "codex-desktop");
  const desktop = desktopRoles.length
    ? await provisionDesktopRoles({
        ...common,
        roles: desktopRoles,
        runtimeEntrypoint: options.runtimeEntrypoint,
      })
    : { roles: [], nextSteps: [] };
  const manualRoles = roles.filter(
    (role) => !HOST_CAPABILITIES[role.host].canProvisionSessions && role.host !== "codex-desktop",
  );
  const manual: { roles: InitializedGenericRole[]; nextSteps: string[] } = manualRoles.length
    ? await initializeGenericTeam({ ...common, roles: manualRoles })
    : { roles: [], nextSteps: [] };
  if ((manualRoles.length || desktopRoles.length) && !kimiRoles.length && !openCodeRoles.length) {
    manual.nextSteps.push(
      "Start a relay for this project with synloq serve --project-root <project> --synloq-home <home> --port <relay-port>; manual MCP inbox channels require a running relay.",
    );
  }
  await store.update((current) => ({
    ...(current ?? { version: 1, project, projectRoot, conversations: {} }),
    placements: {
      ...current?.placements,
      ...Object.fromEntries(
        roles
          .filter((role) => role.host !== "codex-desktop")
          .map((role) => [
            role.agentId,
            {
              host: role.host,
              state: HOST_CAPABILITIES[role.host].canProvisionSessions
                ? ("bound" as const)
                : ("unclaimed" as const),
              instructions: coreRules(role, language).join("\n"),
            },
          ]),
      ),
    },
  }));
  return {
    project,
    roles: roles.map(({ agentId, host }) => ({ agentId, host, ...HOST_CAPABILITIES[host] })),
    kimi,
    opencode,
    manual,
    desktop,
  };
}
