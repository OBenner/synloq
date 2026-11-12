import type { Clock, DeliveryAdapter } from "../adapters/types.js";
import { CredentialStore, type Identity } from "../config/credentials.js";
import { loadManifest } from "../config/manifest.js";
import { projectPaths } from "../config/paths.js";
import { SynloqError } from "../domain/errors.js";
import type { Message, Participant } from "../domain/message.js";
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
import { createDoctorReport, type DoctorReport } from "./doctor.js";

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
  clock?: Clock;
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
  let sessions: SessionStore | undefined;
  let server: RelayHttpServer | undefined;
  try {
    sessions = new SessionStore(paths.database, clock);
    sessions.reapExpired(messages);
    const dispatcher = new Dispatcher(messages, sessions, new Map(options.adapters), clock);
    server = new RelayHttpServer({
      project,
      relay: new RelayService(
        participants,
        messages,
        sessions,
        new ProtectionPolicy(messages, undefined, undefined, clock),
      ),
      credentials: new CredentialStore(options.projectRoot, options.synloqHome),
      sessions,
      dispatcher,
      messages,
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

function storageError(error: unknown): string {
  return error instanceof SynloqError && error.code === "STORAGE_FAILURE"
    ? error.message
    : "storage unavailable";
}

export async function doctorCommand(options: DoctorCommandOptions): Promise<DoctorReport> {
  const participants = await loadManifest(options.projectRoot);
  const project = manifestProject(participants);
  const paths = await projectPaths(options.projectRoot);
  const clock = options.clock ?? { now: () => Date.now() };
  let messages: SQLiteMessageStore | undefined;
  let sessions: SessionStore | undefined;
  try {
    messages = new SQLiteMessageStore(paths.database);
    sessions = new SessionStore(paths.database, clock);
    return createDoctorReport({
      project,
      participants,
      databasePath: paths.database,
      messages,
      sessions,
      clock,
    });
  } catch (error) {
    return createDoctorReport({
      project,
      participants,
      databasePath: paths.database,
      storageError: storageError(error),
      clock,
    });
  } finally {
    sessions?.close();
    messages?.close();
  }
}

export type { PauseScope };
