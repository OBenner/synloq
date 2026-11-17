import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runClaudeHook } from "../../src/cli/claude-hook.js";
import { SynloqError } from "../../src/domain/errors.js";
import type { RelayHttpClient } from "../../src/transport/http-client.js";

const config = { project: "test", agentId: "arch", sessionId: "visible" };
afterEach(() => vi.useRealTimers());

function fixture(event = "SessionStart", hostTimeoutMs?: number) {
  const heartbeat = vi.fn().mockResolvedValue({ session: { generation: 1 } });
  const registerSession = vi.fn();
  const receipt = vi.fn();
  let output = "";
  const client = { heartbeat, registerSession, receipt } as unknown as RelayHttpClient;
  return {
    heartbeat,
    registerSession,
    receipt,
    output: () => output,
    run: (sessionId = config.sessionId) =>
      runClaudeHook(client, config, {
        stdin: Readable.from([JSON.stringify({ session_id: sessionId, hook_event_name: event })]),
        stdout: new Writable({
          write(chunk, _encoding, callback) {
            output += String(chunk);
            callback();
          },
        }),
        ...(hostTimeoutMs === undefined ? {} : { hostTimeoutMs }),
      }),
  };
}

describe("Claude startup heartbeat retry budget", () => {
  it("bounds missing registration to six attempts with the agreed backoff", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const missing = new SynloqError("NOT_FOUND", "session not registered");
    f.heartbeat.mockRejectedValue(missing);
    const done = expect(f.run()).rejects.toBe(missing);
    await vi.runAllTimersAsync();
    await done;
    expect(f.heartbeat.mock.calls.map((c) => c[1])).toEqual([5000, 4900, 4700, 4300, 3500, 2500]);
    expect(f.registerSession).not.toHaveBeenCalled();
    expect(f.receipt).not.toHaveBeenCalled();
    expect(f.output()).toBe("");
  });

  it("accounts for request time and a shorter declared host limit", async () => {
    vi.useFakeTimers();
    const f = fixture("SessionStart", 2000);
    const missing = new SynloqError("NOT_FOUND", "session not registered");
    f.heartbeat.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      throw missing;
    });
    const done = expect(f.run()).rejects.toBe(missing);
    await vi.runAllTimersAsync();
    await done;
    expect(f.heartbeat.mock.calls.map((c) => c[1])).toEqual([1000, 650, 200]);
  });

  it("caps a slow request at the remaining budget without retrying its timeout", async () => {
    vi.useFakeTimers();
    const f = fixture("SessionStart", 1500);
    const timeout = new DOMException("deadline", "TimeoutError");
    f.heartbeat.mockImplementation(async (_input, remaining) => {
      await new Promise((resolve) => setTimeout(resolve, remaining));
      throw timeout;
    });
    const done = expect(f.run()).rejects.toBe(timeout);
    await vi.runAllTimersAsync();
    await done;
    expect(f.heartbeat).toHaveBeenCalledExactlyOnceWith(
      { sessionId: "visible", state: "idle" },
      500,
    );
  });

  it.each(["UNAUTHORIZED", "PERMISSION_DENIED", "INVALID_INPUT", "STORAGE_FAILURE"] as const)(
    "never retries %s",
    async (code) => {
      const f = fixture();
      const failure = new SynloqError(code, "failure");
      f.heartbeat.mockRejectedValue(failure);
      await expect(f.run()).rejects.toBe(failure);
      expect(f.heartbeat).toHaveBeenCalledTimes(1);
      expect(f.registerSession).not.toHaveBeenCalled();
    },
  );

  it("does not retry an untyped lookalike error", async () => {
    const f = fixture();
    f.heartbeat.mockRejectedValue({ code: "NOT_FOUND" });
    await expect(f.run()).rejects.toEqual({ code: "NOT_FOUND" });
    expect(f.heartbeat).toHaveBeenCalledTimes(1);
  });

  it.each(["UserPromptSubmit", "PreToolUse", "Stop", "StopFailure", "SessionEnd"])(
    "never retries NOT_FOUND for %s",
    async (event) => {
      const f = fixture(event);
      f.heartbeat.mockRejectedValue(new SynloqError("NOT_FOUND", "missing"));
      await expect(f.run()).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(f.heartbeat).toHaveBeenCalledTimes(1);
      expect(f.heartbeat.mock.calls[0]).toHaveLength(1);
      expect(f.receipt).not.toHaveBeenCalled();
    },
  );

  it("rejects a mismatched visible session before any request", async () => {
    const f = fixture();
    await expect(f.run("wrong-session")).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(f.heartbeat).not.toHaveBeenCalled();
  });

  it.each([1000, 0, -1, 1500.5, Infinity, NaN])("rejects invalid host limit %s", async (limit) => {
    const f = fixture("SessionStart", limit);
    await expect(f.run()).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(f.heartbeat).not.toHaveBeenCalled();
  });
});
