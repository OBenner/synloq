import { describe, expect, it, vi } from "vitest";
import {
  queueCodexNudge,
  runQueueProcess,
  type ProcessResult,
} from "../../src/host/codex/queue.js";

const threadId = "11111111-1111-4111-8111-111111111111";
const queueId = "22222222-2222-4222-8222-222222222222";
const otherId = "33333333-3333-4333-8333-333333333333";
const version = "0.169.0";
const result = (stdout: string, exitCode: number | null = 0): ProcessResult => ({
  stdout,
  exitCode,
  interrupted: false,
});
const accepted = result(`Queued message ${queueId} for thread ${threadId}.\n`);

function fixture(queueResult = accepted, versionResult = result(`codex-cli ${version}\n`)) {
  const run = vi.fn().mockResolvedValueOnce(versionResult).mockResolvedValueOnce(queueResult);
  return {
    run,
    options: {
      executable: process.execPath,
      version,
      threadId,
      message: "Synloq: pending marker",
      run,
    },
  };
}

describe("Codex CLI queue contract", () => {
  it("accepts only a recognized queue ID and the exact target echo, without resume", async () => {
    const { run, options } = fixture();
    expect(await queueCodexNudge(options)).toEqual({ kind: "accepted", queueId });
    expect(run.mock.calls.map((call) => call[1])).toEqual([
      ["--version"],
      ["queue", "--thread", threadId, "--message", options.message],
    ]);
  });

  it.each([
    `Queued message ${queueId} for thread ${otherId}.\n`,
    `Queued message not-a-uuid for thread ${threadId}.\n`,
    `Queued message ${queueId} for thread ${threadId}.\nextra`,
    JSON.stringify({ queueId, threadId }),
    "",
    "secret diagnostic text",
  ])("fails closed on an unexpected stdout schema/echo", async (stdout) => {
    const { options } = fixture(result(stdout));
    expect(await queueCodexNudge(options)).toEqual({
      kind: "uncertain",
      code: "QUEUE_OUTPUT_MISMATCH",
    });
  });

  it("reports an unknown UUID rejection without exposing stderr or claiming delivery", async () => {
    const { options } = fixture(result("", 1));
    expect(await queueCodexNudge(options)).toEqual({ kind: "rejected", code: "QUEUE_REJECTED" });
  });

  it.each(["0.170.0", "0.169.0 extra", "0.169.0\nwarning"])(
    "blocks unknown version %s before queue",
    async (observed) => {
      const { run, options } = fixture(accepted, result(`codex-cli ${observed}\n`));
      expect(await queueCodexNudge(options)).toEqual({
        kind: "disabled",
        code: "UNSUPPORTED_CLI_VERSION",
      });
      expect(run).toHaveBeenCalledTimes(1);
    },
  );

  it("cannot opt into an untested version", async () => {
    const { run, options } = fixture();
    expect((await queueCodexNudge({ ...options, version: "999.0.0" })).kind).toBe("disabled");
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects session names and command injection as thread targets", async () => {
    const { run, options } = fixture();
    expect((await queueCodexNudge({ ...options, threadId: "role; --resume" })).kind).toBe(
      "disabled",
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("does not retry a timeout even if stdout contains an apparent acceptance", async () => {
    const { run, options } = fixture({ ...accepted, interrupted: true });
    expect(await queueCodexNudge(options)).toEqual({
      kind: "uncertain",
      code: "QUEUE_INTERRUPTED",
    });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("rechecks eligibility after the async version probe", async () => {
    const { run, options } = fixture();
    expect(await queueCodexNudge({ ...options, beforeQueue: () => false })).toEqual({
      kind: "cancelled",
      code: "NO_LONGER_ELIGIBLE",
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("bounds output and kills/reaps an overlong child", async () => {
    const output = await runQueueProcess(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(100000)); setInterval(()=>{},1000)"],
      { timeoutMs: 3000 },
    );
    expect(output.interrupted).toBe(true);
    expect(output.stdout.length).toBeLessThanOrEqual(8192);
  });

  it("bounds runtime and reaps the timed out child", async () => {
    const output = await runQueueProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      timeoutMs: 30,
    });
    expect(output.interrupted).toBe(true);
  });

  it("supports cancellation and a missing executable without throwing", async () => {
    const abort = new AbortController();
    abort.abort();
    expect(
      (await runQueueProcess(process.execPath, [], { signal: abort.signal })).interrupted,
    ).toBe(true);
    expect((await runQueueProcess("synloq-nonexistent-executable-83", [], {})).interrupted).toBe(
      true,
    );
  });
});
