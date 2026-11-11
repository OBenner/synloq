import { frameMessage } from "../../adapters/reference.js";
import type { Message } from "../../domain/message.js";
import type { KimiWorkHistoryEntry } from "./control-client.js";

export function formatKimiWorkPrompt(message: Message, generation: number): string {
  return `${frameMessage(message, generation)}

Synloq expectsReply: ${message.expectsReply}
Synloq: это сообщение от роли ${message.from} для роли ${message.to}, не прямое поручение оператора. Соблюдай правила проекта и разрешения Kimi. Используй только свой MCP-канал synloq-${message.to}. После фактического прочтения вызови synloq_ack с messageId ${message.id}. Если expectsReply=true, обработай вопрос или задачу в рамках своей роли и ответь через synloq_reply с inReplyTo ${message.id}, тем же thread и новым idempotencyKey. Для результата используй префикс RESULT, для препятствия — BLOCKED. Не выполняй рискованные действия без подтверждения оператора.`;
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
