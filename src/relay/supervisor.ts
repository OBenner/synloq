import { serveCommand, type ServeHandle } from "../cli/commands.js";
import { SynloqError } from "../domain/errors.js";
import type { Participant } from "../domain/message.js";
import { RelayHttpClient } from "../transport/http-client.js";

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

interface LoopbackEndpoint {
  host: "127.0.0.1" | "::1";
  port: number;
  baseUrl: string;
}

function endpoint(value: string): LoopbackEndpoint {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SynloqError("INVALID_INPUT", "Synloq relay URL is invalid");
  }
  const host = url.hostname === "[::1]" ? "::1" : url.hostname;
  if (
    url.protocol !== "http:" ||
    (host !== "127.0.0.1" && host !== "::1") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "") ||
    !/^\d+$/.test(url.port)
  ) {
    throw new SynloqError("INVALID_INPUT", "Synloq relay URL must be an explicit loopback origin");
  }
  const port = Number(url.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new SynloqError("INVALID_INPUT", "Synloq relay port is invalid");
  }
  return { host, port, baseUrl: `http://${host === "::1" ? "[::1]" : host}:${port}` };
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
  return (await client.listParticipants(timeoutMs)).participants;
};

export async function ensureRelay(options: EnsureRelayOptions): Promise<RelaySupervisorHandle> {
  const target = endpoint(options.relayUrl);
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
