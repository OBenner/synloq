import { describe, expect, it } from "vitest";
import { nudgeReminder, NUDGE_PAYLOAD_LIMIT } from "../../src/relay/nudge-preview.js";

const message = { id: crypto.randomUUID(), threadId: crypto.randomUUID(), from: "dev", text: "" };
const preview = (text: string) => nudgeReminder({ ...message, text }).split("Read preview: ")[1]!;

describe("bounded read preview", () => {
  it("refuses malformed IDs instead of clipping identifiers or overflowing the payload", () => {
    expect(() => nudgeReminder({ ...message, id: "x".repeat(601) })).toThrow(
      "invalid reminder identifiers",
    );
    expect(() => nudgeReminder({ ...message, threadId: "/absolute/path" })).toThrow(
      "invalid reminder identifiers",
    );
  });
  it("preserves full IDs and the original inbox/ack instruction, adding sender and one line", () => {
    const reminder = nudgeReminder({ ...message, text: "  Ready\nfor\t review  " });
    expect(reminder).toBe(
      `Synloq: pending messageId=${message.id}, threadId=${message.threadId}. Run synloq_inbox on your assigned channel, read the backlog, then ack and reply in the original Synloq thread. From dev. Read preview: Ready for review`,
    );
    expect(preview("\n\t  ")).toBe("");
  });
  it("keeps exactly 200 code points and counts the truncation marker in the limit", () => {
    const exact = "word ".repeat(39) + "hello";
    expect(exact.length).toBe(200);
    expect(preview(exact)).toBe(exact);
    const clipped = preview(exact + " world");
    expect(Array.from(clipped)).toHaveLength(200);
    expect(clipped).toBe(exact.slice(0, 199) + "…");
  });
  it("never splits a surrogate pair and bounds the full Windows CLI payload", () => {
    const reminder = nudgeReminder({ ...message, from: "a".repeat(64), text: "🙂".repeat(300) });
    const excerpt = reminder.split("Read preview: ")[1]!;
    expect(excerpt).toMatch(/^(?:🙂)+…$/u);
    expect(Array.from(excerpt).length).toBeLessThanOrEqual(200);
    expect(reminder.length).toBeLessThanOrEqual(NUDGE_PAYLOAD_LIMIT);
  });
  it.each([
    "Bearer synthetic-value",
    "password='fixture only'",
    "token=fixture",
    "api_key: fixture",
    "secret: sample",
    "C:\\Users\\example\\project",
    "D:/workspace/file",
    "\\\\server\\share",
    "/home/example/file",
    "file:///tmp/file",
    "first line\ntok\u200ben=fixture",
    "ｔｏｋｅｎ=fixture",
    "prefix " + "z9".repeat(23),
    "safe words ".repeat(30) + " password=fixture",
  ])("omits a sensitive-looking message instead of leaking a clipped fragment: %s", (text) => {
    expect(preview(text)).toBe("[preview omitted]");
  });
});
