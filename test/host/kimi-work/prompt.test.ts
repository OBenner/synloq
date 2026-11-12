import { describe, expect, it } from "vitest";
import type { Message } from "../../../src/domain/message.js";
import { frameMessage } from "../../../src/adapters/reference.js";
import {
  findMatchingVisibleTurns,
  formatKimiWorkPrompt,
} from "../../../src/host/kimi-work/prompt.js";
import type { KimiWorkHistoryEntry } from "../../../src/host/kimi-work/control-client.js";

const message: Message = {
  id: "f959f250-7d84-4c81-b9f2-9b600e077f6e",
  threadId: "ad5d204f-1e6e-4b71-8283-f3224c5a742a",
  project: "synloq",
  from: "product-owner",
  to: "reviewer",
  text: "[QUESTION]\nCheck the visible delivery boundary.",
  expectsReply: true,
  idempotencyKey: "prompt-test-1",
  createdAt: "2026-11-11T12:00:00.000Z",
  deliveryState: "stored",
};

function entry(override: Partial<KimiWorkHistoryEntry> = {}): KimiWorkHistoryEntry {
  return {
    id: "history-1",
    turnId: "turn-1",
    role: "user",
    status: "complete",
    text: formatKimiWorkPrompt(message, 3),
    ...override,
  };
}

describe("Kimi Work visible prompt", () => {
  it("preserves the existing frame and adds role-scoped handling instructions", () => {
    const prompt = formatKimiWorkPrompt(message, 3);

    expect(prompt).toContain(frameMessage(message, 3));
    expect(prompt).toContain("Synloq expectsReply: true");
    expect(prompt).toContain("from role product-owner to role reviewer");
    expect(prompt).toContain("synloq-reviewer");
    expect(prompt).toContain(`synloq_ack with messageId ${message.id}`);
    expect(prompt).toContain(`synloq_reply with inReplyTo ${message.id}`);
    expect(prompt).toContain("RESULT");
    expect(prompt).toContain("BLOCKED");
    expect(prompt).toContain("Do not perform risky actions without operator approval.");
  });

  it("uses the real expectsReply value without role-specific branches", () => {
    const prompt = formatKimiWorkPrompt(
      { ...message, from: "cto", to: "arch", expectsReply: false },
      9,
    );

    expect(prompt).toContain(
      frameMessage({ ...message, from: "cto", to: "arch", expectsReply: false }, 9),
    );
    expect(prompt).toContain("Synloq expectsReply: false");
    expect(prompt).toContain("synloq-arch");
    expect(prompt).not.toContain("deliveryState: acked");
  });

  it("matches exactly one complete visible user turn containing the full frame", () => {
    const framedText = formatKimiWorkPrompt(message, 3);
    expect(findMatchingVisibleTurns([entry()], framedText)).toEqual([entry()]);
  });

  it("rejects assistant, incomplete, unrelated, and duplicate matches", () => {
    const framedText = formatKimiWorkPrompt(message, 3);
    const history = [
      entry({ id: "assistant", role: "assistant" }),
      entry({ id: "incomplete", status: "running" }),
      entry({ id: "unrelated", text: "another Synloq message" }),
    ];

    expect(findMatchingVisibleTurns(history, framedText)).toEqual([]);
    expect(
      findMatchingVisibleTurns([entry(), entry({ id: "duplicate" })], framedText),
    ).toHaveLength(2);
  });
});
