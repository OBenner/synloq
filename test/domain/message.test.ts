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
  it("accepts a direct message and enforces the UTF-8 byte boundary", () => {
    const textAtLimit = "🙂".repeat(MAX_TEXT_BYTES / 4);
    const textOverLimit = `${textAtLimit}a`;

    expect(parseSendMessageInput(valid).to).toBe("arch");
    expect(Buffer.byteLength(textAtLimit, "utf8")).toBe(32768);
    expect(parseSendMessageInput({ ...valid, text: textAtLimit }).text).toBe(textAtLimit);
    expect(Buffer.byteLength(textOverLimit, "utf8")).toBe(32769);
    expect(() => parseSendMessageInput({ ...valid, text: textOverLimit })).toThrow(
      "text exceeds 32768 bytes",
    );
  });

  it("rejects an implicit broadcast", () => {
    expect(() => parseSendMessageInput({ ...valid, to: "*" })).toThrow();
  });
});
