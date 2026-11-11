import { z } from "zod";
import type { KimiWorkJsonRpcConnection } from "./json-rpc.js";

export interface KimiWorkBinding {
  workAgentId: string;
  conversationKey: string;
  sessionKey: string;
  workspacePath: string;
  kernelSessionId?: string;
}

export interface KimiWorkMetadata {
  conversationKey: string;
  sessionKey: string;
  kernelSessionId?: string;
  origin: string;
  workspacePath: string;
}

export interface KimiWorkHistoryEntry {
  id: string;
  turnId?: string;
  role: string;
  status: string;
  text: string;
}

export interface KimiWorkSendResult {
  conversationKey: string;
  kernelSessionId: string;
  turnId: string;
  accepted: true;
}

export interface KimiWorkConversationSummary {
  agentId: string;
  sessionKey: string;
  conversationKey: string;
  conversationId: string;
  kernelSessionId?: string;
  origin: string;
  workspacePath?: string;
  clientInstructions?: string;
  title: string;
}

export interface KimiWorkCreateInput {
  agentId: string;
  sessionKey: string;
  origin: "client";
  activate: false;
  workspacePath: string;
  clientInstructions: string;
}

export interface KimiWorkListOptions {
  agentId: string;
  sessionKey?: string;
  origin?: "client";
  workspacePath?: string;
  limit?: number;
  cursor?: string;
  includeTemporary?: boolean;
}

export interface KimiWorkListResult {
  conversations: KimiWorkConversationSummary[];
  page: { limit: number; hasMore: boolean; nextCursor?: string };
}

const conversationSummarySchema = z
  .object({
    agentId: z.string().min(1),
    sessionKey: z.string().min(1),
    conversationKey: z.string().min(1),
    conversationId: z.string().min(1),
    kernelSessionId: z.string().min(1).optional(),
    origin: z.string().min(1),
    workspacePath: z.string().min(1).optional(),
    clientInstructions: z.string().min(1).optional(),
    title: z.string(),
  })
  .passthrough();

const createSchema = z.object({ conversation: conversationSummarySchema }).passthrough();
const listSchema = z
  .object({
    conversations: z.array(conversationSummarySchema),
    page: z
      .object({
        limit: z.number().int().positive(),
        hasMore: z.boolean(),
        nextCursor: z.string().min(1).optional(),
      })
      .passthrough(),
  })
  .passthrough();

function conversationSummary(
  conversation: z.infer<typeof conversationSummarySchema>,
): KimiWorkConversationSummary {
  return {
    agentId: conversation.agentId,
    sessionKey: conversation.sessionKey,
    conversationKey: conversation.conversationKey,
    conversationId: conversation.conversationId,
    ...(conversation.kernelSessionId ? { kernelSessionId: conversation.kernelSessionId } : {}),
    origin: conversation.origin,
    ...(conversation.workspacePath ? { workspacePath: conversation.workspacePath } : {}),
    ...(conversation.clientInstructions
      ? { clientInstructions: conversation.clientInstructions }
      : {}),
    title: conversation.title,
  };
}

const metadataSchema = z
  .object({
    conversation: z
      .object({
        conversationKey: z.string().min(1),
        sessionKey: z.string().min(1),
        kernelSessionId: z.string().min(1).optional(),
        origin: z.string().min(1),
        workspacePath: z.string().min(1),
        title: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

const busySchema = z
  .object({ conversationKey: z.string().min(1), busy: z.boolean() })
  .passthrough();

const historySchema = z
  .object({
    messages: z.array(
      z
        .object({
          id: z.string().min(1),
          turnId: z.string().min(1).optional(),
          role: z.string().min(1),
          status: z.string().min(1),
          parts: z.array(
            z
              .object({ kind: z.string().min(1), text: z.string().optional() })
              .passthrough()
              .superRefine((part, context) => {
                if (part.kind === "text" && part.text === undefined) {
                  context.addIssue({ code: "custom", message: "Text part requires text" });
                }
              }),
          ),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const sendSchema = z
  .object({
    accepted: z.boolean(),
    conversationKey: z.string(),
    kernelSessionId: z.string(),
    turnId: z.string(),
  })
  .passthrough();

export class KimiWorkControlClient {
  constructor(private readonly rpc: Pick<KimiWorkJsonRpcConnection, "request">) {}

  async create(input: KimiWorkCreateInput): Promise<KimiWorkConversationSummary> {
    const result = await this.rpc.request("conversations.create", input, createSchema);
    const conversation = conversationSummary(result.conversation);
    if (
      conversation.agentId !== input.agentId ||
      conversation.sessionKey !== input.sessionKey ||
      conversation.origin !== input.origin ||
      conversation.workspacePath !== input.workspacePath ||
      conversation.clientInstructions !== input.clientInstructions
    ) {
      throw new Error("Kimi Work create result does not match the request");
    }
    return conversation;
  }

  async list(options: KimiWorkListOptions): Promise<KimiWorkListResult> {
    const result = await this.rpc.request("conversations.list", options, listSchema);
    return {
      conversations: result.conversations.map(conversationSummary),
      page: {
        limit: result.page.limit,
        hasMore: result.page.hasMore,
        ...(result.page.nextCursor ? { nextCursor: result.page.nextCursor } : {}),
      },
    };
  }

  async metadata(binding: KimiWorkBinding): Promise<KimiWorkMetadata> {
    const result = await this.rpc.request(
      "conversations.getMetadata",
      { agentId: binding.workAgentId, key: binding.conversationKey },
      metadataSchema,
    );
    return {
      conversationKey: result.conversation.conversationKey,
      sessionKey: result.conversation.sessionKey,
      ...(result.conversation.kernelSessionId
        ? { kernelSessionId: result.conversation.kernelSessionId }
        : {}),
      origin: result.conversation.origin,
      workspacePath: result.conversation.workspacePath,
    };
  }

  async busy(binding: KimiWorkBinding): Promise<boolean> {
    const result = await this.rpc.request(
      "conversations.getBusy",
      { conversationKey: binding.conversationKey },
      busySchema,
    );
    if (result.conversationKey !== binding.conversationKey) {
      throw new Error("Kimi Work busy result does not match the binding");
    }
    return result.busy;
  }

  async messages(binding: KimiWorkBinding, limit = 50): Promise<KimiWorkHistoryEntry[]> {
    const result = await this.rpc.request(
      "conversations.getMessages",
      { agentId: binding.workAgentId, conversationKey: binding.conversationKey, limit },
      historySchema,
    );
    return result.messages.map((message) => ({
      id: message.id,
      ...(message.turnId ? { turnId: message.turnId } : {}),
      role: message.role,
      status: message.status,
      text: message.parts
        .filter((part) => part.kind === "text")
        .map((part) => part.text ?? "")
        .join(""),
    }));
  }

  async send(
    binding: KimiWorkBinding,
    text: string,
    signal?: AbortSignal,
  ): Promise<KimiWorkSendResult> {
    const result = await this.rpc.request(
      "conversations.send",
      { agentId: binding.workAgentId, conversationKey: binding.conversationKey, text },
      sendSchema,
      signal ? { signal } : {},
    );
    if (
      !result.accepted ||
      result.conversationKey !== binding.conversationKey ||
      result.turnId.length === 0 ||
      (binding.kernelSessionId !== undefined && result.kernelSessionId !== binding.kernelSessionId)
    ) {
      throw new Error("Kimi Work send result does not match the binding");
    }
    return {
      accepted: true,
      conversationKey: result.conversationKey,
      kernelSessionId: result.kernelSessionId,
      turnId: result.turnId,
    };
  }
}
