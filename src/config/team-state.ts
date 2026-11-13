import { readFile } from "node:fs/promises";
import { z } from "zod";
import { SynloqError } from "../domain/errors.js";
import { agentId } from "../domain/message.js";
import { writeJsonAtomic } from "./atomic-file.js";

const kimiWorkConversationSchema = z
  .object({
    kind: z.literal("kimi-work").optional(),
    agentId,
    workAgentId: z.string().min(1),
    sessionKey: z.string().min(1),
    conversationKey: z.string().min(1).max(256),
    conversationId: z.string().min(1),
    kernelSessionId: z.string().min(1).optional(),
    workspacePath: z.string().min(1),
  })
  .strict();

const opencodeConversationSchema = z
  .object({
    kind: z.literal("opencode"),
    agentId,
    sessionId: z.string().min(1).max(256),
    directory: z.string().min(1),
  })
  .strict();

// Backward compatibility: Kimi Work entries written before the union existed
// carry no `kind`; they parse as kimi-work by default. OpenCode entries always
// carry kind: "opencode".
const conversationSchema = z.union([kimiWorkConversationSchema, opencodeConversationSchema]);

const teamStateSchema = z
  .object({
    version: z.literal(1),
    project: z.string().min(1).max(128),
    projectRoot: z.string().min(1),
    pluginSourcePath: z.string().min(1).optional(),
    conversations: z.record(agentId, conversationSchema),
  })
  .strict();

export type KimiWorkTeamConversation = z.infer<typeof kimiWorkConversationSchema>;
export type OpenCodeTeamConversation = z.infer<typeof opencodeConversationSchema>;
export type TeamConversation = z.infer<typeof conversationSchema>;
export type TeamState = z.infer<typeof teamStateSchema>;

export class TeamStateStore {
  constructor(private readonly path: string) {}

  async read(): Promise<TeamState | undefined> {
    let input: unknown;
    try {
      input = JSON.parse(await readFile(this.path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw this.invalid();
    }
    const parsed = teamStateSchema.safeParse(input);
    if (!parsed.success) throw this.invalid();
    for (const [id, conversation] of Object.entries(parsed.data.conversations)) {
      if (conversation.agentId !== id) throw this.invalid();
    }
    return parsed.data;
  }

  async write(state: TeamState): Promise<void> {
    const parsed = teamStateSchema.safeParse(state);
    if (!parsed.success) throw this.invalid();
    await writeJsonAtomic(this.path, parsed.data);
  }

  async update(
    updater: (state: TeamState | undefined) => TeamState | Promise<TeamState>,
  ): Promise<TeamState> {
    const next = await updater(await this.read());
    await this.write(next);
    return next;
  }

  private invalid(): SynloqError {
    return new SynloqError("INVALID_INPUT", "Synloq team state is invalid");
  }
}
