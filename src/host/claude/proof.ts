import { open } from "node:fs/promises";
import { requireNudgeIds } from "../../relay/nudge-identifiers.js";

export const TRANSCRIPT_LIMIT = 4 * 1024 * 1024;
export function claudeNudgePrompt(ids: string[], marker: string): string {
  requireNudgeIds(...ids, marker.replace(/^NUDGE-ACK-/, ""));
  if (!marker.startsWith("NUDGE-ACK-") || ids.length > 100) throw new Error("invalid marker");
  return `Synloq nudge: ${ids.length} pending message(s), messageId ${ids.join(", ")}. Use only your assigned Synloq channel. First call synloq_inbox, paginate and read the backlog, then synloq_ack each unacknowledged message, including all these IDs, after reading it. Do not send or reply. After successful acknowledgements reply with exactly: ${marker}`;
}

type Row = {
  type?: string;
  subtype?: string;
  sessionId?: string;
  uuid?: string;
  parentUuid?: string | null;
  message?: { role?: string; content?: unknown };
};
type Block = {
  type?: string;
  id?: string;
  name?: string;
  input?: { messageId?: string };
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
  text?: string;
};
export interface TranscriptParentLink {
  type: "system" | "attachment";
  subtype?: string;
  sessionId: string;
  uuid: string;
  parentUuid: string;
}

/** Project known service nodes onto their nearest conversational ancestor.
 * A side attachment may branch off a tool call, but it cannot move the active
 * conversational chain or contribute tool/marker evidence. Only backward,
 * same-session links are admitted; unresolved parents and UUID reuse fail closed. */
class ConversationChain {
  private readonly ancestors: Map<string, { conversation: string; depth: number }>;
  private current: string;
  private serviceNodes = 0;
  constructor(
    private readonly sessionId: string,
    previousUuid: string,
  ) {
    if (!previousUuid) throw new Error("missing transcript anchor");
    this.current = previousUuid;
    this.ancestors = new Map([[previousUuid, { conversation: previousUuid, depth: 0 }]]);
  }
  bridge(row: Row): TranscriptParentLink | undefined {
    // Non-graph diagnostics need no ancestry, and can never supply evidence.
    if (row.uuid === undefined && row.parentUuid === undefined) return undefined;
    if (
      row.type !== "attachment" &&
      !(row.type === "system" && row.subtype === "stop_hook_summary")
    )
      throw new Error("unsupported service node");
    const ancestor = this.parent(row);
    if (++this.serviceNodes > 1024 || ancestor.depth >= 64) throw new Error("service graph limit");
    this.ancestors.set(row.uuid!, {
      conversation: ancestor.conversation,
      depth: ancestor.depth + 1,
    });
    return {
      type: row.type,
      ...(row.subtype === undefined ? {} : { subtype: row.subtype }),
      sessionId: this.sessionId,
      uuid: row.uuid!,
      parentUuid: row.parentUuid!,
    };
  }
  conversation(row: Row): void {
    if (this.parent(row).conversation !== this.current) throw new Error("forked conversation");
    this.current = row.uuid!;
    this.ancestors.set(this.current, { conversation: this.current, depth: 0 });
  }
  private parent(row: Row): { conversation: string; depth: number } {
    if (
      row.sessionId !== this.sessionId ||
      typeof row.uuid !== "string" ||
      !row.uuid ||
      this.ancestors.has(row.uuid) ||
      typeof row.parentUuid !== "string"
    )
      throw new Error("invalid transcript parent link");
    const ancestor = this.ancestors.get(row.parentUuid);
    if (ancestor === undefined) throw new Error("unresolved transcript parent");
    return ancestor;
  }
}
export interface TranscriptCheckpoint {
  size: number;
  ino: number;
  dev: number;
  previousUuid: string;
  /** Service-node ancestry after the last conversation, not arbitrary last-row UUID. */
  parentLinks?: readonly TranscriptParentLink[];
}
export async function checkpointTranscript(
  path: string,
  sessionId: string,
): Promise<TranscriptCheckpoint> {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || !stat.size || stat.size > TRANSCRIPT_LIMIT)
      throw new Error("unverified transcript");
    const bytes = Buffer.alloc(stat.size + 1);
    const read = await file.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead !== stat.size) throw new Error("changed transcript");
    const text = bytes.subarray(0, read.bytesRead).toString("utf8");
    if (!text.endsWith("\n")) throw new Error("partial transcript");
    const rows = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Row);
    const conversations = rows.filter((row) => row.type === "user" || row.type === "assistant");
    const last = conversations.at(-1);
    if (
      !last?.uuid ||
      last.sessionId !== sessionId ||
      !conversations.some((row) => row.type === "assistant" && row.sessionId === sessionId)
    )
      throw new Error("unpersisted conversation");
    const chain = new ConversationChain(sessionId, last.uuid);
    const parentLinks: TranscriptParentLink[] = [];
    for (const row of rows.slice(rows.lastIndexOf(last) + 1)) {
      const link = chain.bridge(row);
      if (link) parentLinks.push(link);
    }
    return { size: stat.size, ino: stat.ino, dev: stat.dev, previousUuid: last.uuid, parentLinks };
  } finally {
    await file.close();
  }
}
export async function transcriptDelta(
  path: string,
  checkpoint: TranscriptCheckpoint,
): Promise<string> {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    const length = stat.size - checkpoint.size;
    if (
      stat.ino !== checkpoint.ino ||
      stat.dev !== checkpoint.dev ||
      length <= 0 ||
      length > TRANSCRIPT_LIMIT
    )
      throw new Error("changed transcript");
    const bytes = Buffer.alloc(length);
    const read = await file.read(bytes, 0, length, checkpoint.size);
    if (read.bytesRead !== length) throw new Error("partial transcript");
    return bytes.toString("utf8");
  } finally {
    await file.close();
  }
}

/** Host evidence is correlated to this fresh branch; authenticated SQLite is the arbiter. */
export function verifyClaudeTurn(input: {
  delta: string;
  sessionId: string;
  agentId: string;
  targetId: string;
  targetIds?: string[];
  marker: string;
  previousUuid: string;
  parentLinks?: readonly TranscriptParentLink[];
  acknowledged: () => boolean;
}): boolean {
  try {
    if (Buffer.byteLength(input.delta) > TRANSCRIPT_LIMIT || !input.delta.endsWith("\n"))
      return false;
    const rows = input.delta
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Row);
    const chain = new ConversationChain(input.sessionId, input.previousUuid);
    for (const link of input.parentLinks ?? []) chain.bridge(link);
    let marker = false;
    const targets = input.targetIds ?? [input.targetId],
      inboxIds = new Set<string>(),
      ackIds = new Set<string>();
    const uses = new Map<string, Block>();
    for (const row of rows) {
      if (row.type !== "user" && row.type !== "assistant") {
        chain.bridge(row);
        continue;
      }
      chain.conversation(row);
      if (!Array.isArray(row.message?.content)) continue;
      for (const b of row.message.content as Block[]) {
        if (row.type === "assistant" && b.type === "tool_use" && b.id) {
          if (uses.has(b.id)) return false;
          if (
            b.name === `mcp__synloq-${input.agentId}__synloq_ack` &&
            !inboxIds.has(b.input?.messageId ?? "")
          )
            return false;
          uses.set(b.id, b);
        }
        if (row.type === "user" && b.type === "tool_result" && b.tool_use_id && !b.is_error) {
          const use = uses.get(b.tool_use_id);
          if (!use || typeof b.content !== "string") continue;
          const value = JSON.parse(b.content);
          if (
            use.name === `mcp__synloq-${input.agentId}__synloq_inbox` &&
            Array.isArray(value.messages) &&
            value.messages.some((m: { id?: string }) => typeof m.id === "string")
          )
            for (const message of value.messages)
              if (typeof message.id === "string") inboxIds.add(message.id);
          if (
            inboxIds.has(use.input?.messageId ?? "") &&
            use.name === `mcp__synloq-${input.agentId}__synloq_ack` &&
            value.message?.id === use.input?.messageId &&
            value.message?.deliveryState === "acked"
          )
            ackIds.add(value.message.id);
        }
        if (
          row.type === "assistant" &&
          b.type === "text" &&
          b.text === input.marker &&
          targets.every((id) => inboxIds.has(id) && ackIds.has(id))
        )
          marker = true;
      }
    }
    return (
      marker && targets.every((id) => inboxIds.has(id) && ackIds.has(id)) && input.acknowledged()
    );
  } catch {
    return false;
  }
}
