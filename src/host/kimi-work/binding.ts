import { realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { SynloqError } from "../../domain/errors.js";
import { agentId } from "../../domain/message.js";
import type { KimiWorkBinding } from "./control-client.js";

export const kimiWorkConfigurationSchema = z
  .object({
    projectRoot: z.string().min(1),
    agentId,
    conversationKey: z.string().min(1).max(256),
    workAgentId: z.string().min(1).max(128).default("main"),
  })
  .strict();

export type KimiWorkConfiguration = z.input<typeof kimiWorkConfigurationSchema>;

export interface ResolvedKimiWorkBinding extends KimiWorkBinding {
  agentId: string;
}

function invalidBinding(): SynloqError {
  return new SynloqError("INVALID_INPUT", "Kimi Work binding configuration is invalid");
}

function parseConversationKey(value: string): string {
  const separator = ":conversation:";
  const position = value.indexOf(separator);
  if (position < 0 || position !== value.lastIndexOf(separator)) throw invalidBinding();
  const sessionKey = value.slice(0, position);
  const conversationId = value.slice(position + separator.length);
  if (
    !/^agent:[a-z][a-z0-9-]{0,63}:[a-z][a-z0-9-]{0,63}$/.test(sessionKey) ||
    !z.string().uuid().safeParse(conversationId).success
  ) {
    throw invalidBinding();
  }
  return sessionKey;
}

export async function resolveKimiWorkBinding(
  configPath: string,
  input: unknown,
): Promise<ResolvedKimiWorkBinding> {
  try {
    const configuration = kimiWorkConfigurationSchema.parse(input);
    return {
      agentId: configuration.agentId,
      workAgentId: configuration.workAgentId,
      conversationKey: configuration.conversationKey,
      sessionKey: parseConversationKey(configuration.conversationKey),
      workspacePath: await realpath(resolve(dirname(configPath), configuration.projectRoot)),
    };
  } catch (error) {
    if (error instanceof SynloqError) throw error;
    throw invalidBinding();
  }
}
