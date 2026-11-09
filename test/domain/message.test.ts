import { describe, expect, it } from "vitest";
import { MAX_TEXT_BYTES, parseSendMessageInput } from "../../src/domain/message.js";

const valid = {
  project: "verdicta",
  from: "cto",
  to: "arch",
  text: "Review the storage boundary",
  expectsReply: true,
  idempotencyKey: "cto-0001",
};

describe("parseSendMessageInput", () => {
  it("accepts a direct message and rejects oversized UTF-8 text", () => {
    expect(parseSendMessageInput(valid).to).toBe("arch");
    expect(() => parseSendMessageInput({ ...valid, text: "🙂".repeat(MAX_TEXT_BYTES) })).toThrow(
      "text exceeds 32768 bytes",
    );
  });

  it("rejects an implicit broadcast", () => {
    expect(() => parseSendMessageInput({ ...valid, to: "*" })).toThrow();
  });
});
