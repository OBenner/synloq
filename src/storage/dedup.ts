import { createHash } from "node:crypto";
import type { SendMessageInput } from "../domain/message.js";

export const DAY_MS = 86_400_000;
export const DEDUP_WINDOW_MS = 7 * DAY_MS;

export function contentHash(
  input: Pick<SendMessageInput, "to" | "text" | "expectsReply" | "inReplyTo">,
): string {
  return createHash("sha256")
    .update(JSON.stringify([input.to, input.text, input.expectsReply, input.inReplyTo ?? null]))
    .digest("hex");
}
