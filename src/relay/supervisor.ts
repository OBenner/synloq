import { serveCommand, type ServeHandle } from "../cli/commands.js";
import { SynloqError } from "../domain/errors.js";
import type { Participant } from "../domain/message.js";
import { RelayHttpClient } from "../transport/http-client.js";
import { parseLoopbackHttpUrl } from "../transport/loopback.js";

export type RelayProbe = (
  relayUrl: string,
  token: string,
  timeoutMs: number,
) => Promise<Participant[]>;

export interface EnsureRelayOptions {
  projectRoot: string;
  project: string;
  relayUrl: string;
  token: string;
  synloqHome?: string;
  probeTimeoutMs?: number;
  serve?: typeof serveCommand;
  probe?: RelayProbe;
}

export interface RelaySupervisorHandle {
  baseUrl: string;
  client: RelayHttpClient;
  owned: boolean;
  close(): Promise<void>;
}

function hasErrorCode(error: unknown, code: string, depth = 0): boolean {
  if (depth > 4 || typeof error !== "object" || error === null) return false;
  if ("code" in error && error.code === code) return true;
  if ("cause" in error && hasErrorCode(error.cause, code, depth + 1)) return true;
  if ("errors" in error && Array.isArray(error.errors)) {
    return error.errors.some((nested) => hasErrorCode(nested, code, depth + 1));
  }
  return false;
}

function unavailable(): SynloqError {
  return new SynloqError("STORAGE_FAILURE", "Synloq relay endpoint is unavailable or incompatible");
}

const defaultProbe: RelayProbe = async (relayUrl, token, timeoutMs) => {
  const client = new RelayHttpClient(relayUrl, () => token);
  // Verify the unauthenticated health marker before any credential is sent:
  // a port-squatting listener must never receive the bearer token.
  await client.health(timeoutMs);
  return (await client.listParticipants(timeoutMs)).participants;
};

export async function ensureRelay(options: EnsureRelayOptions): Promise<RelaySupervisorHandle> {
  const target = parseLoopbackHttpUrl(options.relayUrl);
  const probe = options.probe ?? defaultProbe;
  const timeoutMs = options.probeTimeoutMs ?? 750;
  const client = new RelayHttpClient(target.baseUrl, () => options.token);
  const compatible = async (): Promise<RelaySupervisorHandle> => {
    const participants = await probe(target.baseUrl, options.token, timeoutMs);
    if (
      participants.length === 0 ||
      participants.some((participant) => participant.project !== options.project)
    ) {
      throw new SynloqError("INVALID_INPUT", "Synloq relay project does not match");
    }
    return { baseUrl: target.baseUrl, client, owned: false, close: async () => undefined };
  };

  try {
    return await compatible();
  } catch (error) {
    if (!hasErrorCode(error, "ECONNREFUSED")) {
      if (error instanceof SynloqError) throw error;
      throw unavailable();
    }
  }

  const serve = options.serve ?? serveCommand;
  let owned: ServeHandle;
  try {
    owned = await serve({
      projectRoot: options.projectRoot,
      ...(options.synloqHome ? { synloqHome: options.synloqHome } : {}),
      host: target.host,
      port: target.port,
    });
  } catch (error) {
    if (hasErrorCode(error, "EADDRINUSE")) {
      try {
        return await compatible();
      } catch (probeError) {
        if (probeError instanceof SynloqError) throw probeError;
        throw unavailable();
      }
    }
    throw unavailable();
  }

  if (owned.baseUrl !== target.baseUrl) {
    await owned.close();
    throw unavailable();
  }
  let closed = false;
  return {
    baseUrl: target.baseUrl,
    client,
    owned: true,
    close: async () => {
      if (closed) return;
      closed = true;
      await owned.close();
    },
  };
}
