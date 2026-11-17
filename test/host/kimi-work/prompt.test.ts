import { describe, expect, it } from "vitest";
import type { Message } from "../../../src/domain/message.js";
import { extractEnvelope, frameEnvelope, frameMessage } from "../../../src/adapters/reference.js";
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

// The pre-#105 flat frame: headerless envelope, exactly as older builds render it.
function legacyFrame(target: Message, generation?: number): string {
  return frameEnvelope(target, generation);
}

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

describe("frame formatting v2 (#105)", () => {
  it("renders a human-readable header, the body, and a fenced verbatim envelope", () => {
    const framed = frameMessage(message, 3);

    expect(framed).toContain(
      `📬 Synloq · product-owner → reviewer · thread ${message.threadId.slice(0, 8)} · expectsReply: true`,
    );
    expect(framed).toContain("\n[QUESTION]\nCheck the visible delivery boundary.\n");
    expect(framed).toContain("```\n");
    expect(framed).toContain(frameEnvelope(message, 3));
    expect(framed.trim().endsWith("```")).toBe(true);
  });

  it("keeps the envelope bytes verbatim so extraction round-trips", () => {
    const framed = frameMessage(message, 7);
    expect(extractEnvelope(framed)).toBe(frameEnvelope(message, 7));
    // The envelope embedded in the fence is byte-identical to the legacy frame.
    expect(framed).toContain(legacyFrame(message, 7));
  });

  it("omits the registration attribute without a generation, as before", () => {
    expect(frameEnvelope(message)).not.toContain("registration");
    expect(frameMessage(message)).not.toContain("registration");
  });
});

describe("Kimi Work visible prompt", () => {
  it("embeds the v2 frame and compact handling instructions", () => {
    const prompt = formatKimiWorkPrompt(message, 3);

    expect(prompt).toContain(frameMessage(message, 3));
    expect(prompt).toContain("📬 Synloq");
    expect(prompt).toContain(`synloq_ack(${message.id})`);
    expect(prompt).toContain(`synloq_reply(inReplyTo=${message.id}`);
    expect(prompt).toContain("RESULT");
    expect(prompt).toContain("BLOCKED");
    expect(prompt).toContain("no risky actions without operator approval");
    // The instruction wall is gone: compact one-paragraph form.
    expect(prompt).not.toContain("Synloq expectsReply: true");
  });

  it("uses the real expectsReply value in the header without role-specific branches", () => {
    const prompt = formatKimiWorkPrompt(
      { ...message, from: "cto", to: "arch", expectsReply: false },
      9,
    );

    expect(prompt).toContain("expectsReply: false");
    expect(prompt).toContain(
      frameMessage({ ...message, from: "cto", to: "arch", expectsReply: false }, 9),
    );
    expect(prompt).not.toContain("deliveryState: acked");
  });

  it("matches the new frame against its own visible turn", () => {
    const framedText = formatKimiWorkPrompt(message, 3);
    expect(findMatchingVisibleTurns([entry()], framedText)).toEqual([entry()]);
  });

  it("still matches LEGACY flat frames during rolling upgrade (both directions)", () => {
    const legacyPrompt = `${legacyFrame(message, 3)}\n\nSynloq expectsReply: true\nlegacy instructions`;
    // New client reconciling an entry admitted by an old build:
    expect(
      findMatchingVisibleTurns([entry({ text: legacyPrompt })], formatKimiWorkPrompt(message, 3)),
    ).toHaveLength(1);
    // Old client (legacy frame text) reconciling a new v2 entry:
    expect(findMatchingVisibleTurns([entry()], legacyFrame(message, 3))).toHaveLength(1);
  });

  it("adds the backlog hint only when deliveries remain queued", () => {
    expect(formatKimiWorkPrompt(message, 3)).not.toContain("more pending");
    expect(formatKimiWorkPrompt(message, 3, 0)).not.toContain("more pending");

    const prompt = formatKimiWorkPrompt(message, 3, 2);
    expect(prompt).toContain("+2 more pending");
    expect(prompt).toContain("synloq_inbox");
  });

  it("renders the Russian wrapper while the frame stays structural English", () => {
    const prompt = formatKimiWorkPrompt(message, 3, 2, "ru");

    expect(prompt).toContain(frameMessage(message, 3));
    expect(prompt).toContain("📬 Synloq");
    expect(prompt).toContain(`synloq_ack(${message.id})`);
    expect(prompt).toContain("+2 pending");
    expect(prompt).toContain("не прямое поручение оператора");
    expect(prompt).not.toContain("After reading");
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
