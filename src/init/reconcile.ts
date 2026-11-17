import { realpath } from "node:fs/promises";
import { relative } from "node:path";
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
import {
  CONFIG_PROVISIONERS,
  type ConfigProvisionerRegistry,
  type ProvisionedConfigs,
} from "./config-provisioners.js";
import { isWithin, resolvePlacement } from "./placement.js";
import type { InitializeTeamOptions, KimiWorkInitHost } from "./types.js";

export type ReconcileOptions = Omit<InitializeTeamOptions, "host" | "pluginSourcePath"> & {
  pluginSourcePath?: string;
};
export interface ReconcileDependencies {
  configProvisioners?: ConfigProvisionerRegistry;
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
  const registry = dependencies.configProvisioners ?? CONFIG_PROVISIONERS;
  const plannedDirectories: string[] = [];
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
    if (role.placement && !HOST_CAPABILITIES[role.host].canProvisionConfig)
      throw new SynloqError("INVALID_INPUT", `placement is unsupported for ${role.host}`);
    if (HOST_CAPABILITIES[role.host].canProvisionConfig) {
      if (!registry[role.host])
        throw new SynloqError("INVALID_INPUT", `no config provisioner for ${role.host}`);
      const directory = await resolvePlacement(projectRoot, paths, role.agentId, role.placement);
      const previous = state?.placements?.[role.agentId];
      if (previous) {
        const recorded = await resolvePlacement(
          projectRoot,
          paths,
          role.agentId,
          previous.directory,
        );
        if (relative(directory, recorded) !== "")
          throw new SynloqError(
            "INVALID_INPUT",
            `role ${role.agentId} placement changed; use explicit operator migration`,
          );
      }
      if (
        plannedDirectories.some((other) => isWithin(other, directory) || isWithin(directory, other))
      )
        throw new SynloqError("INVALID_INPUT", "role placement directories must not overlap");
      for (const [id, placement] of Object.entries(state?.placements ?? {})) {
        if (id === role.agentId || !HOST_CAPABILITIES[placement.host].canProvisionConfig) continue;
        const other = await resolvePlacement(projectRoot, paths, id, placement.directory);
        if (isWithin(other, directory) || isWithin(directory, other))
          throw new SynloqError("INVALID_INPUT", "placement overlaps another provisioned role");
      }
      plannedDirectories.push(directory);
    }
  }
  const kimiRoles = roles.filter((role) => role.host === "kimi-work");
  if (kimiRoles.length && !options.pluginSourcePath)
    throw new SynloqError("INVALID_INPUT", "Kimi Work requires a plugin source path");
  const manifestParticipants = roles.map(({ agentId, title, role, host, placement }) => ({
    project,
    agentId,
    title,
    role,
    host,
    ...(placement ? { placement } : {}),
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
  const configRoles = roles.filter((role) => HOST_CAPABILITIES[role.host].canProvisionConfig);
  const desktop: ProvisionedConfigs = { roles: [], nextSteps: [] };
  for (const host of new Set(configRoles.map((role) => role.host))) {
    const result = await registry[host]!.provision({
      ...common,
      roles: configRoles.filter((role) => role.host === host),
      runtimeEntrypoint: options.runtimeEntrypoint,
    });
    desktop.roles.push(...result.roles);
    desktop.nextSteps.push(...result.nextSteps);
  }
  const manualRoles = roles.filter(
    (role) =>
      !HOST_CAPABILITIES[role.host].canProvisionSessions &&
      !HOST_CAPABILITIES[role.host].canProvisionConfig,
  );
  const manual: { roles: InitializedGenericRole[]; nextSteps: string[] } = manualRoles.length
    ? await initializeGenericTeam({ ...common, roles: manualRoles })
    : { roles: [], nextSteps: [] };
  if ((manualRoles.length || configRoles.length) && !kimiRoles.length && !openCodeRoles.length) {
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
          .filter((role) => !HOST_CAPABILITIES[role.host].canProvisionConfig)
          .map((role) => [
            role.agentId,
            {
              host: role.host,
              state: HOST_CAPABILITIES[role.host].canProvisionSessions
                ? ("bound" as const)
                : current?.placements?.[role.agentId]?.state === "bound"
                  ? ("bound" as const)
                  : ("unclaimed" as const),
              instructions: coreRules(
                role,
                language,
                roles.map((member) => ({ agentId: member.agentId, host: member.host })),
              ).join("\n"),
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
