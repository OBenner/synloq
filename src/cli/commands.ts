import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Clock, DeliveryAdapter } from "../adapters/types.js";
import { writeTextAtomic } from "../config/atomic-file.js";
import { CredentialStore, type Identity } from "../config/credentials.js";
import { loadManifest } from "../config/manifest.js";
import { projectPaths } from "../config/paths.js";
import { TeamStateStore } from "../config/team-state.js";
import { SynloqError } from "../domain/errors.js";
import type { Message, Participant } from "../domain/message.js";
import { checkPluginFreshness, type PluginFreshness } from "../host/kimi-work/installed-plugin.js";
import { ManifestParticipantDirectory } from "../relay/participant-directory.js";
import { FileSecurityAuditLog } from "../relay/audit-log.js";
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
import { createDoctorReport, type DoctorReport, type SynloqHomeProbe } from "./doctor.js";
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
  const audit = new FileSecurityAuditLog(join(paths.home, "data", `${paths.key}-audit.jsonl`));
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
    server = new RelayHttpServer({
      project,
      relay: new RelayService(
        directory,
        messages,
        sessions,
        new ProtectionPolicy(messages, undefined, undefined, clock),
        undefined,
        undefined,
        audit,
      ),
      credentials: new CredentialStore(options.projectRoot, options.synloqHome),
      sessions,
      dispatcher,
      messages,
      audit,
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

async function requireLocalOperator(
  options: TokenLifecycleOptions,
): Promise<{ project: string; store: CredentialStore }> {
  const participants = await loadManifest(options.projectRoot);
  const project = manifestProject(participants);
  const store = new CredentialStore(options.projectRoot, options.synloqHome);
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
  // Issue #36 (b): flag a stale installed plugin copy. Local file reads only —
  // doctor stays offline-safe; any failure degrades to a note, not an error.
  let plugin: PluginFreshness | undefined;
  try {
    const state = await new TeamStateStore(paths.bindings).read();
    if (state?.pluginSourcePath) {
      plugin = await checkPluginFreshness(state.pluginSourcePath, {
        ...(options.pluginsRegistryPath ? { registryPath: options.pluginsRegistryPath } : {}),
      });
    }
  } catch {
    plugin = { sourcePath: "", stale: false, note: "registry-unreadable" };
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
      messages,
      sessions,
      clock,
      ...(plugin ? { plugin } : {}),
    });
  } catch (error) {
    return createDoctorReport({
      project,
      participants,
      databasePath: paths.database,
      home,
      storageError: storageError(error),
      clock,
      ...(plugin ? { plugin } : {}),
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
