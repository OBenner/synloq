import { describe, expect, it } from "vitest";
import { mapCodexHook } from "../../src/adapters/codex-state.js";

describe("Codex hook state mapping", () => {
  it.each(["startup", "resume", "clear", "fork"])(
    "maps SessionStart source %s to idle",
    (source) => {
      expect(mapCodexHook("SessionStart", source)).toBe("idle");
    },
  );

  it("does not treat compact mid-turn startup as idle", () => {
    expect(mapCodexHook("SessionStart", "compact")).toBe("busy");
  });

  it.each([
    ["UserPromptSubmit", "busy"],
    ["PreModelRequest", "busy"],
    ["Stop", "idle"],
    ["Interrupt", "unknown"],
    ["SessionEnd", "closed"],
    ["PostModelRequest", "unknown"],
    ["SubagentStop", "unknown"],
    ["PreToolUse", "unknown"],
  ] as const)("maps %s to %s", (event, expected) => {
    expect(mapCodexHook(event)).toBe(expected);
  });

  it("fails closed for an unknown start source or event", () => {
    expect(mapCodexHook("SessionStart", "unexpected")).toBe("unknown");
    expect(mapCodexHook("SessionStart")).toBe("unknown");
    expect(mapCodexHook("UnexpectedEvent")).toBe("unknown");
  });
});
