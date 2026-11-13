import { realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { SynloqError } from "../../domain/errors.js";
import { agentId } from "../../domain/message.js";

export const openCodeConfigurationSchema = z
  .object({
    projectRoot: z.string().min(1),
    agentId,
    // Optional because init renders configs before the visible session exists
    // when the OpenCode service is unreachable at init time.
    sessionId: z.string().min(1).optional(),
  })
  .strict();

export type OpenCodeConfiguration = z.input<typeof openCodeConfigurationSchema>;

export interface ResolvedOpenCodeBinding {
  agentId: string;
  workspacePath: string;
  sessionId?: string;
}

export async function resolveOpenCodeBinding(
  configPath: string,
  input: unknown,
): Promise<ResolvedOpenCodeBinding> {
  try {
    const configuration = openCodeConfigurationSchema.parse(input);
    return {
      agentId: configuration.agentId,
      workspacePath: await realpath(resolve(dirname(configPath), configuration.projectRoot)),
      ...(configuration.sessionId ? { sessionId: configuration.sessionId } : {}),
    };
  } catch (error) {
    if (error instanceof SynloqError) throw error;
    throw new SynloqError("INVALID_INPUT", "OpenCode binding configuration is invalid");
  }
}
