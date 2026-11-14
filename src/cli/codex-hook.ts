import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { mapCodexHook } from "../adapters/codex-state.js";
import { SynloqError } from "../domain/errors.js";
import { PROTOCOL_VERSION } from "../domain/session.js";
import type { RelayHttpClient } from "../transport/http-client.js";

const MAX_HOOK_BYTES = 64 * 1024;

/**
 * Interrupt and SessionEnd hooks are configured with a 3-second host-side
 * timeout (docs/adapters/codex.md). That budget covers process startup, stdin
 * read, and the relay call — so these events get a shorter relay timeout than
 * the client default (5 s), otherwise the host could kill the hook mid-write
 * and the `unknown`/`closed` state would never reach the relay. The value
 * must stay below the configured hook timeout with room for Node startup.
 */
const QUICK_HOOK_EVENTS = new Set(["Interrupt", "SessionEnd"]);
const QUICK_HOOK_RELAY_TIMEOUT_MS = 2_000;
const hookSchema = z
  .object({
    session_id: z.string().min(1),
    hook_event_name: z.string().min(1),
    source: z.string().optional(),
  })
  .passthrough();

export interface CodexHookConfig {
  project: string;
  agentId: string;
  sessionId: string;
}

export interface CodexHookIo {
  stdin?: Readable;
  stdout?: Writable;
}

async function readInput(input: Readable): Promise<string> {
  const decoder = new StringDecoder("utf8");
  let bytes = 0;
  let source = "";
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    bytes += buffer.byteLength;
    if (bytes > MAX_HOOK_BYTES) {
      throw new SynloqError("INVALID_INPUT", "Codex hook input exceeds 65536 bytes");
    }
    source += decoder.write(buffer);
  }
  return source + decoder.end();
}

export async function runCodexHook(
  client: RelayHttpClient,
  config: CodexHookConfig,
  io: CodexHookIo = {},
): Promise<void> {
  let input: unknown;
  try {
    input = JSON.parse(await readInput(io.stdin ?? process.stdin));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new SynloqError("INVALID_INPUT", "Codex hook contains malformed JSON");
    }
    throw error;
  }
  const hook = hookSchema.parse(input);
  if (hook.session_id !== config.sessionId) {
    throw new SynloqError("UNAUTHORIZED", "session ID does not match the visible binding");
  }

  const state = mapCodexHook(hook.hook_event_name, hook.source);
  const relayTimeoutMs = QUICK_HOOK_EVENTS.has(hook.hook_event_name)
    ? QUICK_HOOK_RELAY_TIMEOUT_MS
    : undefined;
  if (hook.hook_event_name === "SessionStart") {
    const { session } = await client.registerSession(
      {
        sessionId: hook.session_id,
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          activeDelivery: false,
          stateReporting: true,
          clientIdempotency: false,
        },
      },
      relayTimeoutMs,
    );
    if (
      session.project !== config.project ||
      session.agentId !== config.agentId ||
      session.sessionId !== config.sessionId
    ) {
      throw new SynloqError("UNAUTHORIZED", "registered session does not match Codex binding");
    }
  }
  await client.heartbeat({ sessionId: hook.session_id, state }, relayTimeoutMs);
}
