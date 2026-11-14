import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Clock, DeliveryAdapter } from "../adapters/types.js";
import { writeTextAtomic } from "../config/atomic-file.js";
import { ClaimCodeStore, claimCodeAgentId, type IssuedClaimCode } from "../config/claim-codes.js";
import { CredentialStore, type Identity } from "../config/credentials.js";
import { loadManifest } from "../config/manifest.js";
import { projectPaths } from "../config/paths.js";
import { TeamStateStore, type TeamState } from "../config/team-state.js";
import { SynloqError } from "../domain/errors.js";
import type { Message, Participant } from "../domain/message.js";
import { checkPluginFreshness, type PluginFreshness } from "../host/kimi-work/installed-plugin.js";
import { ManifestParticipantDirectory } from "../relay/participant-directory.js";
import {
  FileSecurityAuditLog,
  auditLogPath,
  readAuditTail,
  type SecurityAuditLog,
} from "../relay/audit-log.js";
import { Dispatcher } from "../relay/dispatcher.js";
import { ProtectionPolicy } from "../relay/protection.js";
import { RelayService, type InboxResult, type SendRequest } from "../relay/relay-service.js";
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
  type SynloqHomeProbe,
} from "./doctor.js";
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
}

export interface ServeHandle {
  baseUrl: string;
  server: RelayHttpServer;
  messages: SQLiteMessageStore;
  sessions: SessionStore;
  close(): Promise<void>;
}

export interface DoctorCommandOptions {
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
  const participants = await loadManifest(options.projectRoot);
  const project = manifestProject(participants);
  const paths = await projectPaths(options.projectRoot, options.synloqHome);
  const clock = options.clock ?? { now: () => Date.now() };
  const messages = new SQLiteMessageStore(paths.database, clock);
  const audit = new FileSecurityAuditLog(auditLogPath(paths.home, paths.key));
  // The participant registry is hot (issue #36): adding a role to
  // synloq.yaml takes effect without a relay restart. A manifest that fails
  // to re-parse degrades to the last good snapshot and is audited.
  const directory = await ManifestParticipantDirectory.load(options.projectRoot, {
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
  try {
    sessions = new SessionStore(paths.database, clock);
    sessions.reapExpired(messages);
    const dispatcher = new Dispatcher(messages, sessions, new Map(options.adapters), clock);
    // One policy instance feeds both the relay service (send-side limits) and
    // the HTTP layer (per-identity long-poll cap, security M2).
    const protection = new ProtectionPolicy(messages, undefined, undefined, clock);
    server = new RelayHttpServer({
      project,
      relay: new RelayService(
        directory,
        messages,
        sessions,
        protection,
        undefined,
        undefined,
        audit,
      ),
      credentials: new CredentialStore(options.projectRoot, options.synloqHome),
      sessions,
      dispatcher,
      messages,
      audit,
      protection,
    });
    const baseUrl = await server.listen(options.host ?? "127.0.0.1", options.port ?? 0);
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
        try {
          await openServer.close();
        } finally {
          try {
            openSessions.close();
          } finally {
            messages.close();
          }
        }
      },
    };
  } catch (error) {
    if (server) await server.close();
    sessions?.close();
    messages.close();
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
  const store = new ClaimCodeStore(
    new TeamStateStore(paths.bindings),
    options.clock ?? { now: () => Date.now() },
  );
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

function storageError(error: unknown): string {
  return error instanceof SynloqError &&
    (error.code === "STORAGE_FAILURE" || error.code === "PERMISSION_DENIED")
    ? error.message
    : "storage unavailable";
}

export async function doctorCommand(options: DoctorCommandOptions): Promise<DoctorReport> {
  const participants = await loadManifest(options.projectRoot);
  const project = manifestProject(participants);
  const paths = await projectPaths(options.projectRoot, options.synloqHome);
  const home = await probeSynloqHome(paths.home);
  const clock = options.clock ?? { now: () => Date.now() };
  // Issue #3 (M4-min): doctor surfaces the audit tail so the rotation runbook
  // scenario is reproducible from audit entries alone. Offline-safe read.
  const auditPath = auditLogPath(paths.home, paths.key);
  const audit = { path: auditPath, entries: await readAuditTail(auditPath, 20) };

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
  for (const participant of participants) {
    const binding = teamState?.conversations[participant.agentId];
    if (!binding || binding.kind === "opencode") continue;
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
    messages = new SQLiteMessageStore(paths.database);
    sessions = new SessionStore(paths.database, clock);
    return createDoctorReport({
      project,
      participants,
      databasePath: paths.database,
      home,
      credentials: credentialsHealth,
      configs: configsHealth,
      messages,
      sessions,
      clock,
      audit,
      ...(plugin ? { plugin } : {}),
      ...(repair ? { repair } : {}),
    });
  } catch (error) {
    return createDoctorReport({
      project,
      participants,
      databasePath: paths.database,
      home,
      credentials: credentialsHealth,
      configs: configsHealth,
      storageError: storageError(error),
      clock,
      audit,
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
  const paths = await projectPaths(options.projectRoot, options.synloqHome);
  const home = await probeSynloqHome(paths.home);
  const clock = options.clock ?? { now: () => Date.now() };
  let messages: SQLiteMessageStore | undefined;
  let sessions: SessionStore | undefined;
  try {
    messages = new SQLiteMessageStore(paths.database);
    sessions = new SessionStore(paths.database, clock);
    return createStatusReport({
      project,
      participants,
      databasePath: paths.database,
      home,
      messages,
      sessions,
      clock,
      ...(options.unansweredThresholdMs === undefined
        ? {}
        : { unansweredThresholdMs: options.unansweredThresholdMs }),
    });
  } catch (error) {
    return createStatusReport({
      project,
      participants,
      databasePath: paths.database,
      home,
      storageError: storageError(error),
      clock,
    });
  } finally {
    sessions?.close();
    messages?.close();
  }
}

export type { PauseScope };
