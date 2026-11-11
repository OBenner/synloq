import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { CodexJsonRpcConnection, CodexRpcError } from "../../scripts/codex-app-server/json-rpc.js";

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
