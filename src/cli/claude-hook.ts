import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import { mapClaudeHook } from "../adapters/claude-state.js";
import type { DeliveryEvidence } from "../adapters/types.js";
import { SynloqError } from "../domain/errors.js";
import { agentId } from "../domain/message.js";
import type { RelayHttpClient } from "../transport/http-client.js";

const hookSchema = z
  .object({
    session_id: z.string().min(1),
    hook_event_name: z.string().min(1),
    prompt: z.string().optional(),
  })
  .passthrough();

const synloqEnvelope = /<synloq([^>]*)>\n[\s\S]*?\n<\/synloq>/;
const envelopeAttribute = /\s+(project|from|message|thread|registration)="([^"]*)"/g;
const provenanceSchema = z
  .object({
    project: z.string().min(1).max(128),
    from: agentId,
    message: z.string().uuid(),
    thread: z.string().min(1),
    registration: z.coerce.number().int().positive(),
  })
  .strict();

export interface ClaudeHookConfig {
  project: string;
  agentId: string;
  sessionId: string;
}

export interface ClaudeHookIo {
  stdin?: Readable;
  stdout?: Writable;
  /** Declared host hook timeout; reserve 1 s for CLI startup and shutdown. */
  hostTimeoutMs?: number;
}

const STARTUP_BACKOFF_MS = [100, 200, 400, 800, 1_000] as const;

async function startupHeartbeat(
  client: RelayHttpClient,
  sessionId: string,
  deadline: number,
): ReturnType<RelayHttpClient["heartbeat"]> {
  let lastError: SynloqError | undefined;
  for (let attempt = 0; ; attempt++) {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) {
      throw lastError ?? new SynloqError("STORAGE_FAILURE", "Claude startup hook budget exhausted");
    }
    try {
      return await client.heartbeat({ sessionId, state: "idle" }, remaining);
    } catch (error) {
      // Only the MCP child may register. A missing registration during startup
      // is transient; auth failures and all other errors must remain fail-closed.
      if (!(error instanceof SynloqError) || error.code !== "NOT_FOUND") throw error;
      lastError = error;
      const delay = STARTUP_BACKOFF_MS[attempt];
      if (delay === undefined || deadline - performance.now() <= delay) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}

async function readInput(input: Readable): Promise<string> {
  let source = "";
  for await (const chunk of input) source += String(chunk);
  return source;
}

function synloqProvenance(
  prompt: string | undefined,
): Omit<DeliveryEvidence, "sessionId"> | undefined {
  if (prompt === undefined) return undefined;
  const envelope = synloqEnvelope.exec(prompt);
  const source = envelope?.[1];
  if (source === undefined) return undefined;

  const attributes: Record<string, string> = {};
  let consumed = 0;
  for (const match of source.matchAll(envelopeAttribute)) {
    const key = match[1];
    const value = match[2];
    if (match.index !== consumed || key === undefined || value === undefined) return undefined;
    if (attributes[key] !== undefined) return undefined;
    attributes[key] = value;
    consumed += match[0].length;
  }
  if (consumed !== source.length) return undefined;

  const parsed = provenanceSchema.safeParse(attributes);
  if (!parsed.success) return undefined;
  return {
    project: parsed.data.project,
    from: parsed.data.from,
    messageId: parsed.data.message,
    threadId: parsed.data.thread,
    generation: parsed.data.registration,
  };
}

export async function runClaudeHook(
  client: RelayHttpClient,
  config: ClaudeHookConfig,
  io: ClaudeHookIo = {},
): Promise<void> {
  const startedAt = performance.now();
  if (
    io.hostTimeoutMs !== undefined &&
    (!Number.isSafeInteger(io.hostTimeoutMs) || io.hostTimeoutMs <= 1_000)
  ) {
    throw new SynloqError("INVALID_INPUT", "Claude host timeout must be an integer above 1000 ms");
  }
  const startupBudgetMs = Math.min(5_000, (io.hostTimeoutMs ?? 6_000) - 1_000);
  let input: unknown;
  try {
    input = JSON.parse(await readInput(io.stdin ?? process.stdin));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new SynloqError("INVALID_INPUT", "Claude hook contains malformed JSON");
    }
    throw error;
  }
  const hook = hookSchema.parse(input);
  if (hook.session_id !== config.sessionId) {
    throw new SynloqError("UNAUTHORIZED", "session ID does not match the visible binding");
  }

  const mapped = mapClaudeHook(hook.hook_event_name);
  const { session } =
    hook.hook_event_name === "SessionStart"
      ? await startupHeartbeat(client, hook.session_id, startedAt + startupBudgetMs)
      : await client.heartbeat({ sessionId: hook.session_id, state: mapped.state });
  if (hook.hook_event_name !== "UserPromptSubmit") return;

  const provenance = synloqProvenance(hook.prompt);
  if (provenance === undefined || provenance.project !== config.project) return;
  await client.receipt(
    provenance.messageId,
    {
      state: "delivered",
      clientMessageId: provenance.messageId,
      evidence: { sessionId: hook.session_id, ...provenance },
    },
    { sessionId: hook.session_id, generation: session.generation },
  );
}
