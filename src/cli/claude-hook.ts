import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import { mapClaudeHook } from "../adapters/claude-state.js";
import { SynloqError } from "../domain/errors.js";
import type { RelayHttpClient } from "../transport/http-client.js";

const hookSchema = z
  .object({
    session_id: z.string().min(1),
    hook_event_name: z.string().min(1),
    prompt: z.string().optional(),
  })
  .passthrough();

const synloqEnvelope = /<synloq\b[^>]*\bmessage="([^"]+)"[^>]*>[\s\S]*?<\/synloq>/;

export interface ClaudeHookConfig {
  project: string;
  agentId: string;
  sessionId: string;
}

export interface ClaudeHookIo {
  stdin?: Readable;
  stdout?: Writable;
}

async function readInput(input: Readable): Promise<string> {
  let source = "";
  for await (const chunk of input) source += String(chunk);
  return source;
}

function synloqMessageId(prompt: string | undefined): string | undefined {
  if (prompt === undefined) return undefined;
  const envelope = synloqEnvelope.exec(prompt);
  const candidate = envelope?.[1];
  if (candidate === undefined) return undefined;
  const parsed = z.string().uuid().safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

export async function runClaudeHook(
  client: RelayHttpClient,
  config: ClaudeHookConfig,
  io: ClaudeHookIo = {},
): Promise<void> {
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
  await client.heartbeat({ sessionId: hook.session_id, state: mapped.state });
  if (hook.hook_event_name !== "UserPromptSubmit") return;

  const messageId = synloqMessageId(hook.prompt);
  if (messageId === undefined) return;
  await client.receipt(messageId, { state: "delivered", clientMessageId: messageId });
}
