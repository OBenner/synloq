import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { SynloqError } from "../domain/errors.js";
import type { InboxOptions, RelayHttpClient } from "../transport/http-client.js";

const listInputSchema = z.object({}).strict();
const sendInputSchema = z
  .object({
    to: z.string(),
    text: z.string(),
    expectsReply: z.boolean(),
    idempotencyKey: z.string(),
  })
  .strict();
const replyInputSchema = z
  .object({
    inReplyTo: z.string().uuid(),
    text: z.string(),
    expectsReply: z.boolean(),
    idempotencyKey: z.string(),
  })
  .strict();
const inboxInputSchema = z
  .object({
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();
const waitInputSchema = z
  .object({ waitMs: z.number().int().min(0).max(25000).default(25000) })
  .strict();
const ackInputSchema = z.object({ messageId: z.string().uuid() }).strict();

function result(structuredContent: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent: structuredContent as Record<string, unknown>,
  };
}

function errorResult(error: SynloqError): CallToolResult {
  return {
    ...result({ error: { code: error.code, message: error.message } }),
    isError: true,
  };
}

async function invoke(operation: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return result(await operation());
  } catch (error) {
    if (error instanceof SynloqError) return errorResult(error);
    throw error;
  }
}

export function registerSynloqTools(server: McpServer, client: RelayHttpClient): void {
  server.registerTool(
    "synloq_list",
    {
      description: "List project participants and role descriptions",
      inputSchema: listInputSchema,
    },
    async () => invoke(() => client.listParticipants()),
  );

  server.registerTool(
    "synloq_send",
    {
      description: "Send a direct message to one participant",
      inputSchema: sendInputSchema,
    },
    async (input) => invoke(() => client.send(input)),
  );

  server.registerTool(
    "synloq_reply",
    {
      description: "Reply in an existing thread",
      inputSchema: replyInputSchema,
    },
    async (input) => invoke(() => client.reply(input)),
  );

  server.registerTool(
    "synloq_inbox",
    {
      description: "Read pending or historical incoming messages",
      inputSchema: inboxInputSchema,
    },
    async (input) =>
      invoke(() => {
        const options: InboxOptions = { limit: input.limit };
        if (input.cursor !== undefined) options.cursor = input.cursor;
        return client.inbox(options);
      }),
  );

  server.registerTool(
    "synloq_wait",
    {
      description: "Wait for an incoming message; timeout is normal",
      inputSchema: waitInputSchema,
    },
    async (input) => invoke(() => client.inbox({ limit: 1, waitMs: input.waitMs })),
  );

  server.registerTool(
    "synloq_ack",
    {
      description: "Acknowledge that a message was read",
      inputSchema: ackInputSchema,
    },
    async (input) => invoke(() => client.acknowledge(input.messageId)),
  );
}
