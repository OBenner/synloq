import { extractEnvelope, frameMessage } from "../../adapters/reference.js";
import type { Message } from "../../domain/message.js";
import { DEFAULT_LANGUAGE, translate, type Language } from "../../i18n/index.js";
import type { KimiWorkHistoryEntry } from "./control-client.js";

export function formatKimiWorkPrompt(
  message: Message,
  generation: number,
  pendingAfter?: number,
  language: Language = DEFAULT_LANGUAGE,
): string {
  const backlog =
    pendingAfter !== undefined && pendingAfter > 0
      ? `\n${translate(language, "delivery.backlog", { count: pendingAfter })}`
      : "";
  return `${frameMessage(message, generation)}

${translate(language, "delivery.instructions", { from: message.from, to: message.to, messageId: message.id })}${backlog}`;
}

/**
 * Match a delivered frame against visible history. Matching is envelope-based
 * (#105): both the v1 flat frame and the v2 fenced frame embed the identical
 * machine envelope, so mixed-version stands reconcile correctly. Falls back to
 * the full text when no envelope is present (foreign content).
 */
export function findMatchingVisibleTurns(
  history: KimiWorkHistoryEntry[],
  framedText: string,
): KimiWorkHistoryEntry[] {
  const envelope = extractEnvelope(framedText) ?? framedText;
  return history.filter(
    (entry) =>
      entry.role === "user" && entry.status === "complete" && entry.text.includes(envelope),
  );
}
