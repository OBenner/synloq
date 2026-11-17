import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Clock, DeliveryAdapter } from "../adapters/types.js";
import { writeTextAtomic } from "../config/atomic-file.js";
import { ClaimCodeStore, claimCodeAgentId, type IssuedClaimCode } from "../config/claim-codes.js";
import { CredentialStore, type Identity } from "../config/credentials.js";
import {
  loadManifest,
  loadManifestRoles,
  loadManifestRetention,
  manifestUnknownFields,
  removeManifestParticipant,
} from "../config/manifest.js";
import { HOST_CAPABILITIES } from "../config/hosts.js";
import {
  CONFIG_PROVISIONERS,
  type ConfigProvisionerRegistry,
} from "../init/config-provisioners.js";
import { projectPaths } from "../config/paths.js";
import { TeamStateStore, type TeamState } from "../config/team-state.js";
import { SynloqError } from "../domain/errors.js";
import type { Message, Participant } from "../domain/message.js";
import { checkPluginFreshness, type PluginFreshness } from "../host/kimi-work/installed-plugin.js";
import type { OpenCodeSessionHost } from "../host/opencode/client.js";
import {
  readOpenCodeMcpStates,
  type OpenCodeMcpServerState,
} from "../host/opencode/backend-log.js";
import { opencodeMcpServerNames, removeOpencodeMcpServers } from "../host/opencode/config-file.js";
import { ManifestParticipantDirectory } from "../relay/participant-directory.js";
import {
  FileSecurityAuditLog,
  auditLogPath,
  readAuditTail,
  readDirectoryHealth,
  readOpenCodeRegistrations,
  type SecurityAuditLog,
} from "../relay/audit-log.js";
import { Dispatcher } from "../relay/dispatcher.js";
import { startRetentionSweep } from "../relay/retention.js";
import { startCodexNudger } from "../relay/codex-nudger-lifecycle.js";
import { ProtectionPolicy } from "../relay/protection.js";
import { RelayService, type InboxResult, type SendRequest } from "../relay/relay-service.js";
import { acquireServeLock, type ServeLock } from "../relay/serve-lock.js";
import { SQLiteMessageStore, type PauseScope } from "../storage/message-store.js";
import { SessionStore } from "../storage/session-store.js";
import {
  RelayHttpClient,
  type InboxOptions,
  type PauseRequest,
  type ReplaceSessionRequest,
} from "../transport/http-client.js";
import { RelayHttpServer } from "../transport/http-server.js";
import {
  createDoctorReport,
  type CredentialHealth,
  type DoctorReport,
  type OpenCodeHostCheck,
  type SynloqHomeProbe,
  type PlacementHealth,
} from "./doctor.js";
import {
  assertSupportedNode,
  collectVersions,
  type HostVersionProbe,
} from "../diagnostics/versions.js";
import {
  inspectChannelConfig,
  repairTeamConfigs,
  type ChannelConfigHealthReport,
} from "./repair.js";
import { createStatusReport, type StatusReport } from "./status.js";

export interface ServeOptions {
  projectRoot: string;
  synloqHome?: string;
  host?: string;
  port?: number;
  adapters?: ReadonlyMap<string, DeliveryAdapter>;
  clock?: Clock;
  /** Test hook: evaluate a runtime other than the running process (#111). */
  nodeVersion?: string;
}

export interface ServeHandle {
  baseUrl: string;
  server: RelayHttpServer;
  messages: SQLiteMessageStore;
  sessions: SessionStore;
  close(): Promise<void>;
}

export interface DoctorCommandOptions {
  configProvisioners?: ConfigProvisionerRegistry;
  projectRoot: string;
  synloqHome?: string;
  clock?: Clock;
  unansweredThresholdMs?: number;
  // Issue #6: re-render generated role configs and re-issue stale/missing
  // token files from the saved team state before reporting.
  repair?: boolean;
  // Test/embedding hook: override the Kimi Work installed-plugins registry
  // used by the plugin freshness check (issue #36).
  pluginsRegistryPath?: string;
  // Issue #32 (W6): probe the OpenCode host for session liveness. Without
  // the flag doctor stays offline-safe; the host client is injectable for
  // tests, exactly like remove-role.
  checkHost?: boolean;
  // Issue #92: last per-server MCP state from the OpenCode backend log.
  // Injectable for tests; defaults to reading the real backend log tail.
  openCodeMcpStates?: () => Promise<Map<string, OpenCodeMcpServerState>>;
  // Issue #115: injectable host-version probe so tests stay hermetic and
  // offline. Defaults to local --version invocations with bounded timeouts.
  hostVersionProbe?: HostVersionProbe;
  // Issue #115: skip the versions block entirely (embedding scenarios).
  skipVersions?: boolean;
  /** Issue #111 test hook: evaluate a runtime other than the running one. */
  nodeVersion?: string;
  openCodeHost?: OpenCodeSessionHost;
}

/**
 * Reports which Synloq home directory a command resolved and whether the
 * process can actually write there (sandboxed runners often cannot). The
 * probe writes and removes a small file; failures degrade to a diagnostic,
 * never to a thrown error.
 */
async function probeSynloqHome(home: string): Promise<SynloqHomeProbe> {
  const probePath = join(home, `.synloq-write-probe-${process.pid}`);
  try {
    await writeTextAtomic(probePath, "");
    await rm(probePath, { force: true });
    return { path: home, writable: true };
  } catch (error) {
    return {
      path: home,
      writable: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function manifestProject(participants: Participant[]): string {
  const project = participants[0]?.project;
  if (!project) {
    throw new SynloqError("INVALID_INPUT", "manifest must declare at least one agent");
  }
  return project;
}

export async function serveCommand(options: ServeOptions): Promise<ServeHandle> {
  // Issue #111: fail loudly on an unsupported runtime before any write —
  // node:sqlite would otherwise crash opaquely at the first DB open.
  assertSupportedNode(options.nodeVersion);
  const participants = await loadManifest(options.projectRoot);
  const retention = await loadManifestRetention(options.projectRoot);
  const project = manifestProject(participants);
  const paths = await projectPaths(options.projectRoot, options.synloqHome);
  const clock = options.clock ?? { now: () => Date.now() };
  // Issue #110: exactly one serve per project database — the advisory lock is
  // taken before any storage write. A second serve fails ALREADY_RUNNING with
  // the owning PID; ensureRelay treats that like a busy port and re-probes.
  const serveLock = await acquireServeLock(paths.database);
  const messages = new SQLiteMessageStore(paths.database, clock);
  const audit = new FileSecurityAuditLog(auditLogPath(paths.home, paths.key));
  // The participant registry is hot (issue #36): adding a role to
  // synloq.yaml takes effect without a relay restart. A manifest that fails
  // to re-parse degrades to the last good snapshot and is audited.
  const directory = await ManifestParticipantDirectory.load(options.projectRoot, {
    onRecovered: () =>
      audit.record({
        at: new Date(clock.now()).toISOString(),
        project,
        agentId: "relay",
        action: "directory",
        decision: "accept",
        reasonCode: "RECOVERED",
        detail: "manifest directory recovered",
      }),
    onDegraded: (error) =>
      audit.record({
        at: new Date(clock.now()).toISOString(),
        project,
        agentId: "relay",
        action: "directory",
        decision: "degraded",
        reasonCode: error instanceof SynloqError ? error.code : "STORAGE_FAILURE",
        detail: error instanceof Error ? error.message : String(error),
      }),
  });
  let sessions: SessionStore | undefined;
  let server: RelayHttpServer | undefined;
  let stopRetention: (() => void) | undefined;
  let stopCodexNudger: (() => Promise<void>) | undefined;
  try {
    sessions = new SessionStore(paths.database, clock);
    sessions.reapExpired(messages);
    const dispatcher = new Dispatcher(messages, sessions, new Map(options.adapters), clock);
    // One policy instance feeds both the relay service (send-side limits) and
    // the HTTP layer (per-identity long-poll cap, security M2).
    const protection = new ProtectionPolicy(messages, undefined, undefined, clock);
    server = new RelayHttpServer({
      project,
      relay: new RelayService(directory, messages, sessions, protection, undefined, clock, audit),
      credentials: new CredentialStore(options.projectRoot, options.synloqHome),
      sessions,
      dispatcher,
      messages,
      audit,
      protection,
    });
    const baseUrl = await server.listen(options.host ?? "127.0.0.1", options.port ?? 0);
    stopRetention = startRetentionSweep(messages, project, retention.days);
    stopCodexNudger = await startCodexNudger({
      project,
      paths,
      messages,
      sessions,
      directory,
      now: () => clock.now(),
    });
    const openSessions = sessions;
    const openServer = server;
    let closed = false;
    return {
      baseUrl,
      server: openServer,
      messages,
      sessions: openSessions,
      close: async () => {
        if (closed) return;
        closed = true;
        stopRetention?.();
        try {
          await stopCodexNudger?.();
          await openServer.close();
        } finally {
          try {
            openSessions.close();
          } finally {
            try {
              messages.close();
            } finally {
              await serveLock.release();
            }
          }
        }
      },
    };
  } catch (error) {
    stopRetention?.();
    await stopCodexNudger?.();
    if (server) await server.close();
    sessions?.close();
    messages.close();
    await serveLock.release();
    throw error;
  }
}

export function listCommand(client: RelayHttpClient): Promise<{ participants: Participant[] }> {
  return client.listParticipants();
}

export function inboxCommand(
  client: RelayHttpClient,
  options: InboxOptions = {},
): Promise<InboxResult> {
  return client.inbox(options);
}

export async function sendCommand(
  client: RelayHttpClient,
  input: SendRequest,
  identity: Identity,
): Promise<{ message: Message }> {
  if (!identity.operator) {
    throw new SynloqError("UNAUTHORIZED", "operator credential required for CLI send");
  }
  return client.send(input);
}

export function pauseCommand(client: RelayHttpClient, input: PauseRequest): Promise<{ ok: true }> {
  return client.pause(input);
}

export function resumeCommand(client: RelayHttpClient, input: PauseRequest): Promise<{ ok: true }> {
  return client.resume(input);
}

export function replaceSessionCommand(
  client: RelayHttpClient,
  input: ReplaceSessionRequest,
): ReturnType<RelayHttpClient["replaceSession"]> {
  return client.replaceSession(input);
}

export interface TokenLifecycleAuditEvent {
  action: "rotate" | "revoke";
  agentId: string;
  project: string;
  at: string;
}

export interface TokenLifecycleOptions {
  projectRoot: string;
  agentId: string;
  operatorCredentialPath: string;
  synloqHome?: string;
  auditHook?: (event: TokenLifecycleAuditEvent) => void;
}

/**
 * Issue #42: rotation and revocation void any outstanding claim code for the
 * role — a code printed before the rotation must no longer claim.
 */
async function clearOutstandingClaimCode(options: TokenLifecycleOptions): Promise<void> {
  const paths = await projectPaths(options.projectRoot, options.synloqHome);
  await new ClaimCodeStore(new TeamStateStore(paths.bindings)).clear(options.agentId);
}

async function requireLocalOperator(
  options: TokenLifecycleOptions,
): Promise<{ project: string; store: CredentialStore }> {
  const participants = await loadManifest(options.projectRoot);
  const project = manifestProject(participants);
  const paths = await projectPaths(options.projectRoot, options.synloqHome);
  // Issue #3 (M4-min): rotate/revoke are recorded in the persistent audit log.
  const store = new CredentialStore(
    options.projectRoot,
    options.synloqHome,
    new FileSecurityAuditLog(auditLogPath(paths.home, paths.key)),
  );
  const operatorToken = (await readFile(options.operatorCredentialPath, "utf8")).trim();
  if (!operatorToken) {
    throw new SynloqError("INVALID_INPUT", "operator credential file is empty");
  }
  const identity = await store.authenticate(project, operatorToken);
  if (!identity.operator) {
    throw new SynloqError("UNAUTHORIZED", "operator credential required");
  }
  return { project, store };
}

export async function rotateTokenCommand(options: TokenLifecycleOptions): Promise<{
  agentId: string;
  tokenPath: string;
  replacedHashes: number;
}> {
  const { project, store } = await requireLocalOperator(options);
  const rotated = await store.rotate(project, options.agentId);
  await clearOutstandingClaimCode(options);
  options.auditHook?.({
    action: "rotate",
    agentId: options.agentId,
    project,
    at: new Date().toISOString(),
  });
  // The new token exists only in the token file; command output must not
  // contain it.
  return {
    agentId: options.agentId,
    tokenPath: rotated.tokenPath,
    replacedHashes: rotated.replacedHashes,
  };
}

export async function revokeTokenCommand(options: TokenLifecycleOptions): Promise<{
  agentId: string;
  removedHashes: number;
  tokenPath: string;
}> {
  const { project, store } = await requireLocalOperator(options);
  const revoked = await store.revoke(project, options.agentId);
  await clearOutstandingClaimCode(options);
  options.auditHook?.({
    action: "revoke",
    agentId: options.agentId,
    project,
    at: new Date().toISOString(),
  });
  return {
    agentId: options.agentId,
    removedHashes: revoked.removedHashes,
    tokenPath: revoked.tokenPath,
  };
}

export interface ClaimCommandOptions {
  projectRoot: string;
  code: string;
  synloqHome?: string;
  clock?: Clock;
  audit?: SecurityAuditLog;
}

export interface ClaimResult {
  agentId: string;
  credentialPath: string;
  configPath: string;
  nextSteps: string[];
}

/**
 * Issue #42, ADR-0004 layer 3: consumes a one-time claim code and hands the
 * role's local credential/config paths to the caller. The credential file
 * itself is read locally by the host and never travels through chat. Claim
 * accepts and refusals go to the security audit log; an expired code is
 * operational noise (ADR-0004) and is not recorded.
 */
export async function claimCommand(options: ClaimCommandOptions): Promise<ClaimResult> {
  const agentId = claimCodeAgentId(options.code);
  if (!agentId) {
    throw new SynloqError(
      "INVALID_INPUT",
      "malformed claim code; expected synloq-claim-<role>-<8 base32 characters>",
    );
  }
  const participants = await loadManifest(options.projectRoot);
  const project = manifestProject(participants);
  if (!participants.some((participant) => participant.agentId === agentId)) {
    throw new SynloqError("INVALID_INPUT", `claim code names a role outside the manifest`);
  }
  const paths = await projectPaths(options.projectRoot, options.synloqHome);
  const audit = options.audit ?? new FileSecurityAuditLog(auditLogPath(paths.home, paths.key));
  const states = new TeamStateStore(paths.bindings);
  const store = new ClaimCodeStore(states, options.clock ?? { now: () => Date.now() });
  const result = await store.consume(agentId, options.code);
  const event = {
    at: new Date().toISOString(),
    project,
    agentId,
    action: "claim" as const,
  };
  if (result.status === "expired") {
    throw new SynloqError(
      "INVALID_INPUT",
      `claim code for role '${agentId}' expired at ${result.expiresAt}; ` +
        `issue a new one with: synloq claim-issue --project-root <path> --role ${agentId}`,
    );
  }
  if (result.status === "no-outstanding-code") {
    audit.record({
      ...event,
      decision: "deny",
      reasonCode: "NO_OUTSTANDING_CODE",
      detail: "claim attempted without an outstanding code",
    });
    throw new SynloqError(
      "UNAUTHORIZED",
      `role '${agentId}' is already claimed or the code was reissued; ` +
        "to hand the role to another chat use synloq replace-session",
    );
  }
  if (result.status === "code-mismatch") {
    audit.record({
      ...event,
      decision: "deny",
      reasonCode: "CLAIM_CODE_MISMATCH",
      detail: "claim code does not match the outstanding code",
    });
    throw new SynloqError("UNAUTHORIZED", `invalid claim code for role '${agentId}'`);
  }
  await states.update((state) => {
    if (!state) throw new SynloqError("INVALID_INPUT", "Synloq team state is missing");
    const placement = state.placements?.[agentId];
    if (!placement) return state;
    return {
      ...state,
      placements: {
        ...state.placements,
        [agentId]: {
          ...placement,
          state: HOST_CAPABILITIES[placement.host].canProvisionConfig ? "configured" : "bound",
        },
      },
    };
  });
  audit.record({
    ...event,
    decision: "accept",
    reasonCode: "CLAIMED",
    detail: "role claimed via one-time code",
  });
  const credentialPath = join(paths.tokens, `${agentId}.token`);
  const configPath = join(paths.runtime, "mcp", `${agentId}.json`);
  return {
    agentId,
    credentialPath,
    configPath,
    nextSteps: [
      `Wire the MCP config into the host: ${configPath}`,
      "Approve the host's trust dialog for the new MCP server if prompted",
      "Restart the host client so the channel starts",
      `Verify with: synloq doctor --project-root ${options.projectRoot}`,
    ],
  };
}

export interface ClaimIssueCommandOptions {
  projectRoot: string;
  agentId: string;
  synloqHome?: string;
  clock?: Clock;
}

/**
 * Re-issues a claim code without a full init (issue #42): the path an
 * expired-code error message points to. Issuing replaces any outstanding
 * code for the role.
 */
export async function claimIssueCommand(
  options: ClaimIssueCommandOptions,
): Promise<IssuedClaimCode> {
  const participants = await loadManifest(options.projectRoot);
  manifestProject(participants);
  if (!participants.some((participant) => participant.agentId === options.agentId)) {
    throw new SynloqError("INVALID_INPUT", `unknown role: ${options.agentId}`);
  }
  const paths = await projectPaths(options.projectRoot, options.synloqHome);
  return new ClaimCodeStore(
    new TeamStateStore(paths.bindings),
    options.clock ?? { now: () => Date.now() },
  ).issue(options.agentId);
}

export interface RemoveRoleOptions {
  configProvisioners?: ConfigProvisionerRegistry;
  projectRoot: string;
  agentId: string;
  operatorCredentialPath: string;
  synloqHome?: string;
  /** DI for tests; required to delete an OpenCode session, optional otherwise. */
  openCodeHost?: OpenCodeSessionHost;
}

export interface RemoveRoleResult {
  agentId: string;
  manifest: "removed";
  credential: "revoked" | "absent";
  claimCode: "cleared" | "absent";
  session: "deleted" | "already-gone" | "skipped-host-unavailable" | "manual";
  opencodeConfig: "removed" | "absent";
  nextSteps: string[];
}

/**
 * Issue #32 (W5): tears a role down — manifest entry, credential (via the
 * operator-gated revoke path, which also voids outstanding claim codes),
 * OpenCode session and opencode.json entry when the role lived on OpenCode.
 * Kimi Work chats cannot be deleted programmatically; the operator closes
 * them manually. The relay hot-reloads additions, but dropping a role's
 * in-memory state still requires a relay restart — said in nextSteps.
 */
export async function removeRoleCommand(options: RemoveRoleOptions): Promise<RemoveRoleResult> {
  const participants = await loadManifest(options.projectRoot);
  if (!participants.some((participant) => participant.agentId === options.agentId)) {
    throw new SynloqError("INVALID_INPUT", `unknown role: ${options.agentId}`);
  }
  const paths = await projectPaths(options.projectRoot, options.synloqHome);
  const stateStore = new TeamStateStore(paths.bindings);
  const state = await stateStore.read();
  const binding = state?.conversations[options.agentId];

  // 1. Validate the operator credential BEFORE any irreversible host-side
  //    effect: a failed check must leave the stand untouched.
  const operatorToken = (await readFile(options.operatorCredentialPath, "utf8")).trim();
  const operatorIdentity = await new CredentialStore(options.projectRoot, paths.home).authenticate(
    participants[0]!.project,
    operatorToken,
  );
  if (!operatorIdentity.operator) {
    throw new SynloqError("UNAUTHORIZED", "operator credential required");
  }

  // 2. Host session: once the credential is revoked the chat is dead anyway,
  //    but deleting while everything is still up keeps the failure modes
  //    legible.
  let session: RemoveRoleResult["session"] = "manual";
  if (binding?.kind === "opencode") {
    if (!options.openCodeHost) {
      session = "skipped-host-unavailable";
    } else {
      session = (await options.openCodeHost.deleteSession(binding.sessionId))
        ? "deleted"
        : "already-gone";
    }
  }

  // 3. Credential via the operator-gated path (audited, kills claim codes).
  const hadClaimCode = state?.claims?.[options.agentId] !== undefined;
  const revoked = await revokeTokenCommand({
    projectRoot: options.projectRoot,
    agentId: options.agentId,
    operatorCredentialPath: options.operatorCredentialPath,
    ...(options.synloqHome ? { synloqHome: options.synloqHome } : {}),
  });

  // 4. Manifest, opencode.json, team state.
  await removeManifestParticipant(options.projectRoot, options.agentId);
  const removedServers = await removeOpencodeMcpServers(options.projectRoot, [
    `synloq-${options.agentId}`,
  ]);
  if (state?.conversations[options.agentId] || state?.placements?.[options.agentId]) {
    await stateStore.update((current): TeamState => {
      if (!current) throw new SynloqError("INVALID_INPUT", "Synloq team state is missing");
      const conversations = { ...current.conversations };
      delete conversations[options.agentId];
      const placements = { ...current.placements };
      delete placements[options.agentId];
      return { ...current, conversations, placements };
    });
  }

  const nextSteps = ["Restart the relay so the removed role leaves the participant registry"];
  const placement = state?.placements?.[options.agentId];
  const provisioner = placement
    ? (options.configProvisioners ?? CONFIG_PROVISIONERS)[placement.host]
    : undefined;
  if (provisioner) {
    nextSteps.push(
      await provisioner.remove({
        projectRoot: options.projectRoot,
        paths,
        agentId: options.agentId,
        ...(placement ? { placement } : {}),
      }),
    );
  }
  if (session === "manual" && !provisioner) {
    nextSteps.push("Close the role's Kimi Work chat manually — it cannot be deleted via API");
  }
  if (session === "skipped-host-unavailable") {
    nextSteps.push(
      "OpenCode service was unreachable — delete the session manually or re-run with the service up",
    );
  }
  return {
    agentId: options.agentId,
    manifest: "removed",
    credential: revoked.removedHashes > 0 ? "revoked" : "absent",
    claimCode: hadClaimCode ? "cleared" : "absent",
    session,
    opencodeConfig: removedServers.length > 0 ? "removed" : "absent",
    nextSteps,
  };
}

function storageError(error: unknown): string {
  return error instanceof SynloqError &&
    (error.code === "STORAGE_FAILURE" || error.code === "PERMISSION_DENIED")
    ? error.message
    : "storage unavailable";
}

export async function doctorCommand(options: DoctorCommandOptions): Promise<DoctorReport> {
  const participants = await loadManifest(options.projectRoot);
  const manifestRoles = await loadManifestRoles(options.projectRoot);
  const project = manifestProject(participants);
  const paths = await projectPaths(options.projectRoot, options.synloqHome);
  const home = await probeSynloqHome(paths.home);
  const clock = options.clock ?? { now: () => Date.now() };
  // Issue #3 (M4-min): doctor surfaces the audit tail so the rotation runbook
  // scenario is reproducible from audit entries alone. Offline-safe read.
  const auditPath = auditLogPath(paths.home, paths.key);
  const audit = { path: auditPath, entries: await readAuditTail(auditPath, 20) };
  const directoryHealth = await readDirectoryHealth(auditPath, project);
  const manifestWarnings = await manifestUnknownFields(options.projectRoot);
  const openCodeRegistrations = await readOpenCodeRegistrations(auditPath, project);

  // Issue #6: repair first so the report reflects the post-repair state.
  let repair: DoctorReport["repair"];
  if (options.repair) {
    const result = await repairTeamConfigs({
      projectRoot: options.projectRoot,
      ...(options.synloqHome ? { synloqHome: options.synloqHome } : {}),
    });
    repair = { actions: result.actions };
  }

  // Issue #36 (b): flag a stale installed plugin copy. Local file reads only —
  // doctor stays offline-safe; any failure degrades to a note, not an error.
  let plugin: PluginFreshness | undefined;
  let teamState: TeamState | undefined;
  try {
    teamState = await new TeamStateStore(paths.bindings).read();
    if (teamState?.pluginSourcePath) {
      plugin = await checkPluginFreshness(teamState.pluginSourcePath, {
        ...(options.pluginsRegistryPath ? { registryPath: options.pluginsRegistryPath } : {}),
      });
    }
  } catch {
    plugin = { sourcePath: "", stale: false, note: "registry-unreadable" };
  }

  // Issue #6: offline credential health per Kimi Work-bound role — a stale
  // token file is exactly the state a rotation elsewhere leaves behind.
  // Issue #7: the generated channel config must still resolve every embedded
  // path (credential file, bound project root).
  const credentialStore = new CredentialStore(options.projectRoot, options.synloqHome);
  const credentialsHealth = new Map<string, CredentialHealth>();
  const configsHealth = new Map<string, ChannelConfigHealthReport>();
  const placements = new Map<string, PlacementHealth>();
  for (const role of manifestRoles) {
    const host = role.host ?? "kimi-work";
    const binding = teamState?.conversations[role.agentId];
    const prepared = teamState?.placements?.[role.agentId];
    const observedHost = binding ? (binding.kind ?? "kimi-work") : prepared?.host;
    const mismatch = observedHost !== undefined && observedHost !== host;
    const missing = HOST_CAPABILITIES[host].canProvisionSessions ? !binding : !prepared;
    const provisioner = (options.configProvisioners ?? CONFIG_PROVISIONERS)[prepared?.host ?? host];
    const configHealth = provisioner
      ? await provisioner.inspect({
          projectRoot: options.projectRoot,
          paths,
          agentId: role.agentId,
          ...(prepared ? { placement: prepared } : {}),
        })
      : undefined;
    placements.set(role.agentId, {
      host,
      state: binding ? "bound" : (prepared?.state ?? "missing"),
      ok: !mismatch && !missing && (configHealth?.ok ?? true),
      ...(configHealth && !configHealth.ok
        ? { issue: configHealth.issue ?? "role directory is invalid" }
        : {}),
      ...(mismatch
        ? {
            issue: `manifest host ${host} differs from prepared host ${observedHost}; use explicit replace-session/migration`,
          }
        : missing
          ? { issue: "host placement is not initialized; run init" }
          : {}),
    });
  }
  // Issue #32 (W6): OpenCode-bound roles get credential health plus a
  // hostCheck — opencode.json entry always (offline), session liveness only
  // behind --check-host. Host failures degrade to "unknown", never throw:
  // doctor is a diagnostics surface, not a gate.
  const hostChecks = new Map<string, OpenCodeHostCheck>();
  let opencodeServers: string[] | "unreadable" = [];
  try {
    opencodeServers = await opencodeMcpServerNames(options.projectRoot);
  } catch {
    opencodeServers = "unreadable";
  }
  // Issue #92: last per-server MCP state from the OpenCode backend log.
  // A local file read, so it works without --check-host; failures degrade to
  // "unknown", never throw — doctor is a diagnostics surface, not a gate.
  const hasOpenCodeBindings = participants.some(
    (participant) => teamState?.conversations[participant.agentId]?.kind === "opencode",
  );
  let mcpStates: Map<string, OpenCodeMcpServerState> | undefined;
  if (hasOpenCodeBindings) {
    try {
      mcpStates = await (options.openCodeMcpStates ?? (() => readOpenCodeMcpStates()))();
    } catch {
      mcpStates = undefined;
    }
  }
  for (const participant of participants) {
    const binding = teamState?.conversations[participant.agentId];
    if (binding?.kind === "opencode") {
      credentialsHealth.set(
        participant.agentId,
        await credentialStore.inspect(project, participant.agentId),
      );
      const hostCheck: OpenCodeHostCheck = {
        sessionId: binding.sessionId,
        session: "unknown",
        opencodeConfig:
          opencodeServers === "unreadable"
            ? "unreadable"
            : opencodeServers.includes(`synloq-${participant.agentId}`)
              ? "present"
              : "missing",
      };
      const mcp = mcpStates?.get(`synloq-${participant.agentId}`);
      hostCheck.mcp = mcp?.state ?? "unknown";
      if (mcp?.state === "failed") {
        hostCheck.note =
          `MCP server failed${mcp.exitCode === undefined ? "" : ` (exit code ${mcp.exitCode})`}; ` +
          "restart the OpenCode backend (quit from tray or kill the opencode-cli serve process)";
      }
      if (options.checkHost) {
        if (!options.openCodeHost) {
          hostCheck.note = "opencode-host-unreachable";
        } else {
          try {
            hostCheck.session = (await options.openCodeHost.getSession(binding.sessionId))
              ? "alive"
              : "dead";
          } catch (error) {
            hostCheck.note = error instanceof SynloqError ? error.message : "host check failed";
          }
        }
      }
      hostChecks.set(participant.agentId, hostCheck);
      continue;
    }
    if (!binding && !teamState?.placements?.[participant.agentId]) continue;
    credentialsHealth.set(
      participant.agentId,
      await credentialStore.inspect(project, participant.agentId),
    );
    configsHealth.set(
      participant.agentId,
      await inspectChannelConfig(join(paths.runtime, "mcp", `${participant.agentId}.json`)),
    );
  }

  let messages: SQLiteMessageStore | undefined;
  let sessions: SessionStore | undefined;
  try {
    // Doctor only reads: open the store read-only so the diagnostic never
    // takes a write lock on the live relay database (issue #68).
    messages = new SQLiteMessageStore(paths.database, undefined, { readOnly: true });
    sessions = new SessionStore(paths.database, clock, { readOnly: true });
    // Issue #115: one copy-pasteable version block for reproducible reports.
    const versions =
      options.skipVersions === true
        ? undefined
        : await collectVersions({
            databasePath: paths.database,
            ...(options.hostVersionProbe ? { probe: options.hostVersionProbe } : {}),
            ...(options.nodeVersion ? { nodeVersion: options.nodeVersion } : {}),
          });
    return createDoctorReport({
      project,
      participants,
      databasePath: paths.database,
      ...(versions ? { versions } : {}),
      home,
      credentials: credentialsHealth,
      configs: configsHealth,
      hostChecks,
      openCodeRegistrations,
      placements,
      messages,
      sessions,
      clock,
      audit,
      directory: directoryHealth,
      ...(manifestWarnings.length > 0 ? { manifestWarnings } : {}),
      ...(plugin ? { plugin } : {}),
      ...(repair ? { repair } : {}),
    });
  } catch (error) {
    // Issue #115: one copy-pasteable version block for reproducible reports.
    const versions =
      options.skipVersions === true
        ? undefined
        : await collectVersions({
            databasePath: paths.database,
            ...(options.hostVersionProbe ? { probe: options.hostVersionProbe } : {}),
            ...(options.nodeVersion ? { nodeVersion: options.nodeVersion } : {}),
          });
    return createDoctorReport({
      project,
      participants,
      databasePath: paths.database,
      ...(versions ? { versions } : {}),
      home,
      credentials: credentialsHealth,
      configs: configsHealth,
      hostChecks,
      openCodeRegistrations,
      placements,
      storageError: storageError(error),
      clock,
      audit,
      directory: directoryHealth,
      ...(manifestWarnings.length > 0 ? { manifestWarnings } : {}),
      ...(plugin ? { plugin } : {}),
      ...(repair ? { repair } : {}),
    });
  } finally {
    sessions?.close();
    messages?.close();
  }
}

export async function statusCommand(options: DoctorCommandOptions): Promise<StatusReport> {
  const participants = await loadManifest(options.projectRoot);
  const project = manifestProject(participants);
  // Issue #45: the manual-poll note needs the manifest host per role; the
  // doctor entry only carries it when placements were probed.
  const roleHosts = new Map(
    (await loadManifestRoles(options.projectRoot)).map((role) => [
      role.agentId,
      role.host ?? ("kimi-work" as const),
    ]),
  );
  const paths = await projectPaths(options.projectRoot, options.synloqHome);
  const home = await probeSynloqHome(paths.home);
  const clock = options.clock ?? { now: () => Date.now() };
  const auditPath = auditLogPath(paths.home, paths.key);
  const audit = { path: auditPath, entries: await readAuditTail(auditPath, 20) };
  const directoryHealth = await readDirectoryHealth(auditPath, project);
  const directory = directoryHealth;
  // Issue #115: compute outside the try so the degraded (storage-error) report
  // carries versions too.
  const statusVersions =
    options.skipVersions === true
      ? undefined
      : await collectVersions({
          databasePath: paths.database,
          ...(options.hostVersionProbe ? { probe: options.hostVersionProbe } : {}),
          ...(options.nodeVersion ? { nodeVersion: options.nodeVersion } : {}),
        });
  let messages: SQLiteMessageStore | undefined;
  let sessions: SessionStore | undefined;
  try {
    // Status only reads: same read-only rationale as doctor (issue #68).
    messages = new SQLiteMessageStore(paths.database, undefined, { readOnly: true });
    sessions = new SessionStore(paths.database, clock, { readOnly: true });
    return createStatusReport({
      project,
      participants,
      databasePath: paths.database,
      ...(statusVersions ? { versions: statusVersions } : {}),
      home,
      messages,
      sessions,
      clock,
      roleHosts,
      audit,
      directory,
      ...(options.unansweredThresholdMs === undefined
        ? {}
        : { unansweredThresholdMs: options.unansweredThresholdMs }),
    });
  } catch (error) {
    return createStatusReport({
      project,
      participants,
      databasePath: paths.database,
      ...(statusVersions ? { versions: statusVersions } : {}),
      home,
      storageError: storageError(error),
      clock,
      roleHosts,
      audit,
      directory,
    });
  } finally {
    sessions?.close();
    messages?.close();
  }
}

export type { PauseScope };
