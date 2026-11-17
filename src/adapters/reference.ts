import { SynloqError } from "../domain/errors.js";
import type { Message } from "../domain/message.js";
import type { AdapterCapabilities, SessionState } from "../domain/session.js";
import type { DeliveryAdapter, DeliveryReceipt } from "./types.js";

export interface VisibleEntry {
  id: string;
  content: string;
}

/**
 * The machine envelope: the exact wire format since v1, unchanged. Every
 * frame variant (v1 flat, v2 fenced) embeds this verbatim, so envelope-based
 * matching works across mixed-version stands (#105).
 */
export function frameEnvelope(message: Message, generation?: number): string {
  const registration = generation === undefined ? "" : ` registration="${generation}"`;
  return `<synloq project="${message.project}" from="${message.from}" message="${message.id}" thread="${message.threadId}"${registration}>\n${message.text}\n</synloq>`;
}

/**
 * Frame formatting v2 (#105): human-readable header, the body, then the
 * machine envelope in a fenced code block. The envelope bytes stay verbatim
 * inside the fence, so envelope extraction and old-frame parsing keep working
 * during rolling upgrades.
 */
export function frameMessage(message: Message, generation?: number): string {
  return [
    `📬 Synloq · ${message.from} → ${message.to} · thread ${message.threadId.slice(0, 8)} · expectsReply: ${message.expectsReply}`,
    "",
    message.text,
    "",
    "```",
    frameEnvelope(message, generation),
    "```",
  ].join("\n");
}

/** Extract the machine envelope from any frame variant (v1 flat or v2 fenced). */
export function extractEnvelope(framed: string): string | undefined {
  const match = /<synloq[^>]*>\n[\s\S]*?\n<\/synloq>/.exec(framed);
  return match?.[0];
}

export class ReferenceAdapter implements DeliveryAdapter {
  readonly capabilities: AdapterCapabilities;
  private readonly states = new Map<string, SessionState>();
  private readonly entries = new Map<string, VisibleEntry[]>();
  private readonly receipts = new Map<string, DeliveryReceipt>();
  private readonly failures = new Set<string>();

  constructor(
    capabilities: AdapterCapabilities = {
      activeDelivery: true,
      stateReporting: true,
      clientIdempotency: true,
    },
  ) {
    this.capabilities = capabilities;
  }

  async state(sessionId: string): Promise<SessionState> {
    return this.states.get(sessionId) ?? "idle";
  }

  async submit(sessionId: string, message: Message): Promise<DeliveryReceipt> {
    const original = this.receipts.get(message.id);
    if (original) return original;

    if ((await this.state(sessionId)) !== "idle") {
      throw new SynloqError("INVALID_INPUT", "visible session is not idle");
    }
    if (this.failures.delete(message.id)) {
      throw new Error(`forced failure for ${message.id}`);
    }

    const receipt: DeliveryReceipt = { state: "delivered", clientMessageId: message.id };
    this.receipts.set(message.id, receipt);
    this.visible(sessionId).push({ id: message.id, content: frameMessage(message) });
    return receipt;
  }

  setState(sessionId: string, state: SessionState): void {
    this.states.set(sessionId, state);
  }

  failNext(messageId: string): void {
    this.failures.add(messageId);
  }

  visible(sessionId: string): VisibleEntry[] {
    let entries = this.entries.get(sessionId);
    if (!entries) {
      entries = [];
      this.entries.set(sessionId, entries);
    }
    return entries;
  }
}
