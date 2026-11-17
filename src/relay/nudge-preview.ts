import type { Message } from "../domain/message.js";
import { requireNudgeIds } from "./nudge-identifiers.js";

export const NUDGE_PREVIEW_LIMIT = 200;
export const NUDGE_PAYLOAD_LIMIT = 600;
const OMITTED = "[preview omitted]";

/** Conservative shape filter, not a guarantee that arbitrary prose is nonsecret. */
function sensitive(text: string): boolean {
  return (
    /\b(?:bearer|basic|password|passwd|token|secret|api[_ -]?key|authorization|cookie|credential)\b/iu.test(
      text,
    ) ||
    /[A-Za-z0-9_+\/-]{40,}={0,2}/u.test(text) ||
    /\b(?:sk|ghp|github_pat|xox[baprs])[-_]/iu.test(text) ||
    /\bfile:\/\/|[a-z]:[\\/]|\\\\|(?:^|[^A-Za-z0-9])\//iu.test(text)
  );
}

/** Code-point safe, with an additional UTF-16 budget for the Windows CLI argument. */
function clip(text: string, units: number): string {
  const points = Array.from(text);
  if (points.length <= NUDGE_PREVIEW_LIMIT && text.length <= units) return text;
  let result = "";
  for (const point of points.slice(0, NUDGE_PREVIEW_LIMIT - 1)) {
    if (result.length + point.length > units - 1) break;
    result += point;
  }
  return result + "…";
}

export function nudgeReminder(message: Pick<Message, "id" | "threadId" | "from" | "text">): string {
  requireNudgeIds(message.id, message.threadId);
  // Keep the full IDs and original read/ack/reply instruction unchanged.
  const instruction = `Synloq: pending messageId=${message.id}, threadId=${message.threadId}. Run synloq_inbox on your assigned channel, read the backlog, then ack and reply in the original Synloq thread.`;
  const sender = /^[a-z][a-z0-9-]{0,63}$/.test(message.from) ? message.from : "unknown";
  const prefix = `${instruction} From ${sender}. Read preview: `;
  const text = message.text
    .replace(/\s+/gu, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .trim();
  // Inspect the whole message BEFORE truncation, including credential markers
  // beyond the visible prefix. Never fetch credentials to populate a deny list.
  const preview = sensitive(text.normalize("NFKC")) ? OMITTED : text;
  return prefix + clip(preview, Math.max(1, NUDGE_PAYLOAD_LIMIT - prefix.length));
}
