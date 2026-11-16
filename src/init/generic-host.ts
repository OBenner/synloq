import { realpath } from "node:fs/promises";
import { join } from "node:path";
import type { Clock } from "../adapters/types.js";
import { writeJsonAtomic } from "../config/atomic-file.js";
import { ClaimCodeStore, CLAIM_CODE_TTL_MS } from "../config/claim-codes.js";
import { CredentialStore } from "../config/credentials.js";
import { mergeManifestParticipants, type ManifestRole } from "../config/manifest.js";
import { projectPaths } from "../config/paths.js";
import { TeamStateStore, type TeamState } from "../config/team-state.js";
import { SynloqError } from "../domain/errors.js";
import { coreRules } from "./role-prompt.js";
import type { Language } from "../i18n/index.js";
import { FileSecurityAuditLog, auditLogPath } from "../relay/audit-log.js";
import { isLoopbackHttpUrl } from "../transport/loopback.js";
import { parseRoleInputs, resolveLanguage } from "./initialize-team.js";
import { relativeHomePaths } from "./runtime-config.js";
import type { RoleInput } from "./types.js";

export interface InitializeGenericTeamOptions {
  manifestParticipants?: ManifestRole[];
  projectRoot: string;
  project: string;
  roles: RoleInput[];
  synloqHome?: string;
  relayUrl?: string;
  language?: Language;
  clock?: Clock;
}

export interface InitializedGenericRole {
  agentId: string;
  configPath: string;
  credentialPath: string;
  claimCode: string;
  claimCodeExpiresAt: string;
}

export interface InitializeGenericTeamResult {
  project: string;
  manifestPath: string;
  statePath: string;
  registrationRequired: boolean;
  roles: InitializedGenericRole[];
  claimCodeTtlMinutes: number;
  nextSteps: string[];
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
  if (
    state &&
    Object.keys(state.conversations).some(
      (id) => !options.manifestParticipants || roles.some((role) => role.agentId === id),
    )
  ) {
    throw new SynloqError(
      "INVALID_INPUT",
      "roles are already bound to host sessions; re-initialize with their host (--host kimi-work|opencode)",
    );
  }

  const participants: ManifestRole[] = roles.map((role) => ({
    project,
    agentId: role.agentId,
    title: role.title,
    role: role.role,
    host: role.host ?? "generic",
  }));
  // Issue #32 (gap G1): merge into the existing manifest — init --role is
  // the add-role path and must not drop roles from previous runs.
  await mergeManifestParticipants(
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

  const initializedRoles: InitializedGenericRole[] = [];
  for (const role of roles) {
    const credential = await credentials.ensureCredential(project, role.agentId);
    const configPath = join(paths.runtime, "mcp", `${role.agentId}.json`);
    await writeJsonAtomic(configPath, {
      relayUrl,
      // Relative to the config file, like the Kimi/OpenCode renderers (#7/#32).
      credentialPath: relativeHomePaths(paths.key, role.agentId).credentialPath,
      language,
    });
    initializedRoles.push({
      agentId: role.agentId,
      configPath,
      credentialPath: credential.tokenPath,
      claimCode: "",
      claimCodeExpiresAt: "",
    });
  }

  await stateStore.update((current): TeamState => {
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
      placements: {
        ...base.placements,
        ...Object.fromEntries(
          roles.map((role) => [
            role.agentId,
            {
              host: role.host ?? "generic",
              state:
                base.placements?.[role.agentId]?.state === "bound"
                  ? ("bound" as const)
                  : ("unclaimed" as const),
              instructions: coreRules(role, language).join("\n"),
            },
          ]),
        ),
      },
    };
  });

  // Issue #42 (ADR-0004 layer 3): a generic host cannot bind sessions, so
  // every role gets a one-time claim code. The operator pastes it into the
  // chat (or runs synloq claim locally) to pick up the role's credential.
  // Re-running init re-issues codes, voiding previously printed ones.
  const claimCodes = new ClaimCodeStore(stateStore, options.clock ?? { now: () => Date.now() });
  const currentState = await stateStore.read();
  for (const role of initializedRoles) {
    if (currentState?.placements?.[role.agentId]?.state === "bound") continue;
    const issued = await claimCodes.issue(role.agentId);
    role.claimCode = issued.code;
    role.claimCodeExpiresAt = issued.expiresAt;
  }

  return {
    project,
    manifestPath: join(projectRoot, "synloq.yaml"),
    statePath: paths.bindings,
    registrationRequired: false,
    roles: initializedRoles,
    claimCodeTtlMinutes: CLAIM_CODE_TTL_MS / 60_000,
    nextSteps: [
      "Paste each role's claim code into the chat that should take the role, or run: synloq claim --project-root <path> --code <code>",
      `Claim codes expire in ${CLAIM_CODE_TTL_MS / 60_000} minutes; re-issue one with: synloq claim-issue --project-root <path> --role <id>`,
      "Wire each role's configPath into the host's MCP configuration",
      "Approve the host's trust dialogs and restart the host client so the channels start",
    ],
  };
}
