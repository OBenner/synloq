import { z } from "zod";

export const MAX_TEXT_BYTES = 32 * 1024;
export const agentId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);

export const sendMessageInputSchema = z
  .object({
    project: z.string().min(1).max(128),
    from: agentId,
    to: agentId,
    text: z
      .string()
      .min(1)
      .refine(
        (text) => Buffer.byteLength(text, "utf8") <= MAX_TEXT_BYTES,
        "text exceeds 32768 bytes",
      ),
    expectsReply: z.boolean(),
    inReplyTo: z.string().uuid().optional(),
    idempotencyKey: z.string().min(1).max(128),
  })
  .strict();

export type SendMessageInput = z.infer<typeof sendMessageInputSchema>;
export const parseSendMessageInput = (input: unknown): SendMessageInput =>
  sendMessageInputSchema.parse(input);

export interface Message extends SendMessageInput {
  id: string;
  threadId: string;
  createdAt: string;
  deliveryState: "stored" | "submitted" | "delivered" | "acked";
}

export interface Participant {
  project: string;
  agentId: string;
  title: string;
  role: string;
}
