import { frameMessage } from "../../adapters/reference.js";
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

Synloq expectsReply: ${message.expectsReply}
${translate(language, "delivery.instructions", { from: message.from, to: message.to, messageId: message.id })}${backlog}`;
}

export function findMatchingVisibleTurns(
  history: KimiWorkHistoryEntry[],
  framedText: string,
): KimiWorkHistoryEntry[] {
  return history.filter(
    (entry) =>
      entry.role === "user" && entry.status === "complete" && entry.text.includes(framedText),
  );
}
