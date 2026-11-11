import { EventEmitter } from "node:events";
import { execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { CodexJsonRpcConnection, CodexRpcError } from "../../scripts/codex-app-server/json-rpc.js";
import {
  probeCodexAppServer,
  type CodexCommandRunner,
  type CodexProbeOptions,
} from "../../scripts/probe-codex-app-server.js";

interface RpcFrame {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params?: unknown;
}

class FakeCodexChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly frames: RpcFrame[] = [];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  private input = "";

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer | string) => {
      this.input += String(chunk);
      let newline = this.input.indexOf("\n");
      while (newline >= 0) {
        const line = this.input.slice(0, newline);
        this.input = this.input.slice(newline + 1);
        if (line !== "") this.frames.push(JSON.parse(line) as RpcFrame);
        newline = this.input.indexOf("\n");
      }
    });
  }

  get requests(): Array<RpcFrame & { id: number }> {
    return this.frames.filter(
      (frame): frame is RpcFrame & { id: number } => typeof frame.id === "number",
    );
  }

  get notifications(): Array<{ method: string; params: unknown }> {
    return this.frames
      .filter((frame) => frame.id === undefined)
      .map((frame) => ({ method: frame.method, params: frame.params }));
  }

  readonly kill = vi.fn((signal: NodeJS.Signals = "SIGTERM"): boolean => {
    queueMicrotask(() => {
      if (this.exitCode !== null || this.signalCode !== null) return;
      this.signalCode = signal;
      this.emit("exit", null, signal);
    });
    return true;
  });
}

function fakeConnection(): {
  child: FakeCodexChild & ChildProcessWithoutNullStreams;
} {
  const child = new FakeCodexChild() as unknown as FakeCodexChild & ChildProcessWithoutNullStreams;
  return { child };
}

describe("Codex app-server JSON-RPC transport", () => {
  it("handles fragmented responses and server notifications without answering them", async () => {
    const { child } = fakeConnection();
    const connection = new CodexJsonRpcConnection(child, { timeoutMs: 20 });
    const pending = connection.request("initialize", {
      clientInfo: { name: "synloq-test", version: "0" },
    });
    child.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", method: "item/started", params: {} }) + "\n",
    );
    const response = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } });
    child.stdout.write(response.slice(0, 8));
    child.stdout.write(response.slice(8) + "\n");

    await expect(pending).resolves.toEqual({ capabilities: {} });
    expect(child.stderr.listenerCount("data")).toBeGreaterThan(0);
    expect(child.frames).toHaveLength(1);
    await connection.close();
    expect(child.kill).toHaveBeenCalled();
  });

  it("times out without sending a retry and still closes the child", async () => {
    const { child } = fakeConnection();
    const connection = new CodexJsonRpcConnection(child, { timeoutMs: 5 });
    await expect(connection.request("initialize", {})).rejects.toThrow("initialize timed out");
    expect(child.frames).toHaveLength(1);
    await connection.close();
    expect(child.kill).toHaveBeenCalled();
  });

  it("rejects oversized input without resolving a request", async () => {
    const { child } = fakeConnection();
    const connection = new CodexJsonRpcConnection(child, { timeoutMs: 100 });
    const pending = connection.request("initialize", {});
    child.stdout.write(" ".repeat(1024 * 1024 + 1));
    await expect(pending).rejects.toThrow("buffer exceeded");
    await connection.close();
  });

  it("rejects malformed JSON without resolving a request", async () => {
    const { child } = fakeConnection();
    const connection = new CodexJsonRpcConnection(child, { timeoutMs: 100 });
    const pending = connection.request("initialize", {});
    child.stdout.write("not-json\n");
    await expect(pending).rejects.toThrow("malformed JSON");
    await connection.close();
  });

  it("rejects pending requests on stdin failure without leaking stream details", async () => {
    const { child } = fakeConnection();
    const connection = new CodexJsonRpcConnection(child, { timeoutMs: 5 });
    const pending = connection.request("initialize", {});
    const observed = vi.fn();
    child.stdin.once("error", observed);

    child.stdin.emit("error", new Error("EPIPE token=do-not-report"));

    const error = await pending.catch((reason: unknown) => reason);
    expect(observed).toHaveBeenCalledOnce();
    expect(error).toMatchObject({ message: "Codex app-server stdin failed" });
    expect((error as Error).message).not.toContain("do-not-report");
    await connection.close();
  });

  it("keeps the public JSON-RPC error generic and retains detail only for classification", async () => {
    const { child } = fakeConnection();
    const connection = new CodexJsonRpcConnection(child, { timeoutMs: 20 });
    const pending = connection.request("thread/resume", { threadId: "thread-open" });
    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32600, message: "active writer; token=do-not-report" },
      }) + "\n",
    );

    const error = await pending.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(CodexRpcError);
    expect(error).toMatchObject({
      method: "thread/resume",
      rpcCode: -32600,
      message: "thread/resume failed with JSON-RPC -32600",
      remoteDetail: expect.stringContaining("active writer"),
    });
    expect((error as Error).message).not.toContain("do-not-report");
    await connection.close();
  });

  it("escalates a stalled SIGTERM and removes temporary exit/error listeners", async () => {
    const { child } = fakeConnection();
    child.kill.mockImplementationOnce(() => true);
    const connection = new CodexJsonRpcConnection(child, { timeoutMs: 5 });

    await connection.close();

    expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    expect(child.listenerCount("exit")).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
  });
});

interface ProbeFixture {
  initialize: unknown;
  resume?: unknown;
  read?: unknown;
  resumeError?: { code: number; message: string };
}

function fakeProbe(fixture: ProbeFixture): {
  child: FakeCodexChild & ChildProcessWithoutNullStreams;
  commands: Array<{ command: string; args: readonly string[]; cwd: string }>;
  options: CodexProbeOptions;
} {
  const { child } = fakeConnection();
  const commands: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
  const commandRunner: CodexCommandRunner = vi.fn(async (command, args, cwd) => {
    commands.push({ command, args: [...args], cwd });
    const stdout =
      args.join(" ") === "--version"
        ? "codex 0.0.0-test\n"
        : args.join(" ") === "app-server --help"
          ? "app-server test help\n"
          : '{"type":"object"}\n';
    return { stdout, stderr: "" };
  });
  child.stdin.on("data", () => {
    const frame = child.frames.at(-1);
    if (frame?.id === undefined) return;
    queueMicrotask(() => {
      if (frame.method === "thread/resume" && fixture.resumeError !== undefined) {
        child.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: frame.id,
            error: fixture.resumeError,
          }) + "\n",
        );
        return;
      }
      const result =
        frame.method === "initialize"
          ? fixture.initialize
          : frame.method === "thread/resume"
            ? (fixture.resume ?? {})
            : frame.method === "thread/read"
              ? (fixture.read ?? {})
              : {};
      child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }) + "\n");
    });
  });
  const spawnProcess = (() => child) as unknown as NonNullable<CodexProbeOptions["spawnProcess"]>;
  return {
    child,
    commands,
    options: {
      cwd: process.cwd(),
      codexBin: "codex-test",
      spawnProcess,
      commandRunner,
      observedAt: () => "2026-11-11T00:00:00.000Z",
      timeoutMs: 20,
    },
  };
}

describe("Codex read-only app-server probe", () => {
  it("collects metadata and skips resume without an explicit thread ID", async () => {
    const harness = fakeProbe({
      initialize: { serverInfo: { name: "codex", version: "test" }, capabilities: {} },
    });
    const report = await probeCodexAppServer(harness.options);

    expect(harness.commands.map((call) => call.args)).toEqual([
      ["--version"],
      ["app-server", "--help"],
      ["app-server", "generate-json-schema"],
    ]);
    expect(harness.child.requests.map((request) => request.method)).toEqual(["initialize"]);
    expect(harness.child.notifications).toEqual([{ method: "initialized", params: {} }]);
    expect(report.resumeSkippedReason).toBe("thread-id-not-provided");
    expect(report.activeDeliveryClaim).toBe(false);
    expect(report.reason).toBe("visible-session-submission-not-verified");
    expect(JSON.stringify(report)).not.toContain("turn/start");
  });

  it("uses only thread/resume and thread/read for an explicit thread", async () => {
    const harness = fakeProbe({
      initialize: { serverInfo: { name: "codex", version: "test" }, capabilities: {} },
      resume: {
        thread: {
          id: "thread-visible",
          status: { type: "idle" },
          turns: [{ text: "secret prompt" }],
        },
      },
      read: {
        thread: {
          id: "thread-visible",
          status: { type: "idle" },
          turns: [{ text: "secret prompt" }],
        },
      },
    });
    const report = await probeCodexAppServer({
      ...harness.options,
      threadId: "thread-visible",
    });

    expect(harness.child.requests.map((request) => request.method)).toEqual([
      "initialize",
      "thread/resume",
      "thread/read",
    ]);
    expect(report.resume).toMatchObject({ status: "attached", threadId: "thread-visible" });
    expect(JSON.stringify(report)).not.toContain("secret prompt");
    expect(harness.child.requests.some((request) => request.method.startsWith("turn/"))).toBe(
      false,
    );
  });

  it("records an active-writer conflict without retrying or submitting", async () => {
    const harness = fakeProbe({
      initialize: { capabilities: {} },
      resumeError: {
        code: -32600,
        message: "thread already has an active writer; token=do-not-report",
      },
    });
    const report = await probeCodexAppServer({ ...harness.options, threadId: "thread-open" });

    expect(report.resume).toEqual({ status: "writer-conflict", errorCode: -32600 });
    expect(harness.child.requests.map((request) => request.method)).toEqual([
      "initialize",
      "thread/resume",
    ]);
    expect(JSON.stringify(report)).not.toContain("do-not-report");
    expect(report.activeDeliveryClaim).toBe(false);
  });

  it("rejects a mismatched resumed thread without reading it", async () => {
    const harness = fakeProbe({
      initialize: { capabilities: {} },
      resume: { thread: { id: "another-thread" } },
    });
    const report = await probeCodexAppServer({
      ...harness.options,
      threadId: "thread-visible",
    });

    expect(report.resume).toEqual({ status: "error" });
    expect(harness.child.requests.map((request) => request.method)).toEqual([
      "initialize",
      "thread/resume",
    ]);
  });

  it("sanitizes initialize recursively and hashes rather than embeds the schema", async () => {
    const harness = fakeProbe({
      initialize: {
        serverInfo: { name: "codex", version: "test" },
        capabilities: { experimental: { safe: true, prompt: "secret prompt" } },
        token: "secret-token",
        nested: {
          auth: { secret: "nested-secret" },
          account: { name: "private-account" },
          turns: [{ text: "private-turn" }],
          text: "private-text",
        },
        safe: "visible",
        list: ["x".repeat(600), ...Array.from({ length: 40 }, (_, index) => index)],
      },
    });

    const report = await probeCodexAppServer(harness.options);
    const schema = '{"type":"object"}\n';
    expect(report.appServerSchema).toEqual({
      available: true,
      bytes: Buffer.byteLength(schema, "utf8"),
      sha256: createHash("sha256").update(schema, "utf8").digest("hex"),
    });
    expect(report.initialize).toEqual({
      serverInfo: { name: "codex", version: "test" },
      capabilities: { experimental: { safe: true } },
      nested: {},
      safe: "visible",
      list: ["x".repeat(256), ...Array.from({ length: 31 }, (_, index) => index)],
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("private");
    expect(serialized).not.toContain(schema);
  });

  it("runs directly with Node 24 TypeScript module resolution", async () => {
    const scriptPath = fileURLToPath(
      new URL("../../scripts/probe-codex-app-server.ts", import.meta.url),
    );
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      execFile(
        process.execPath,
        [scriptPath, "--cwd", "relative-path"],
        { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL" },
        (error, _stdout, stderr) => {
          resolve({
            code: error === null ? 0 : typeof error.code === "number" ? error.code : null,
            stderr,
          });
        },
      );
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--cwd must be an absolute project path");
    expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
  });
});
