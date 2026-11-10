import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeKimiAcp, type SpawnKimiAcp } from "../../scripts/probe-kimi-acp.js";
import { KimiFallbackAdapter } from "../../src/adapters/kimi-fallback.js";
import { inactiveReason } from "../../src/adapters/types.js";
import type { Message } from "../../src/domain/message.js";
import { PROTOCOL_VERSION, type AdapterSession } from "../../src/domain/session.js";

const cwd = resolve("kimi-probe-project");
const observedAt = "2026-11-10T01:02:03.000Z";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

type FakeRequestHandler = (request: JsonRpcRequest, child: FakeKimiProcess) => void;

class FakeKimiProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly requests: JsonRpcRequest[] = [];
  readonly kill = vi.fn(() => true);

  constructor(onRequest: FakeRequestHandler) {
    super();
    let buffered = "";
    this.stdin.on("data", (chunk: Buffer | string) => {
      buffered += chunk.toString();
      while (true) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line.trim() === "") continue;
        const request = JSON.parse(line) as JsonRpcRequest;
        this.requests.push(request);
        onRequest(request, this);
      }
    });
  }

  succeed(id: number, result: unknown, fragmented = false): void {
    const response = JSON.stringify({ jsonrpc: "2.0", id, result });
    if (fragmented) {
      const midpoint = Math.floor(response.length / 2);
      this.stdout.write(response.slice(0, midpoint));
      this.stdout.write(`${response.slice(midpoint)}\n`);
    } else {
      this.stdout.write(`${response}\n`);
    }
  }

  fail(id: number, code: number, message: string): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
  }
}

function fakeProbe(onRequest: FakeRequestHandler) {
  const child = new FakeKimiProcess(onRequest);
  const calls: Array<{
    command: string;
    args: readonly string[];
    options: Parameters<SpawnKimiAcp>[2];
  }> = [];
  const spawnProcess: SpawnKimiAcp = (command, args, options) => {
    calls.push({ command, args, options });
    return child as unknown as ChildProcessWithoutNullStreams;
  };
  return {
    child,
    calls,
    options: { cwd, observedAt: () => observedAt, spawnProcess },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("probeKimiAcp", () => {
  it("resumes an explicitly selected ACP v1 session without prompting", async () => {
    const initialize = {
      protocolVersion: 1,
      agentInfo: { name: "Kimi Code", version: "1.2.3" },
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { resume: {} },
      },
      extension: { preserved: ["raw", "initialize"] },
    };
    const resumeResult = { resumed: "without-replay" };
    const harness = fakeProbe((request, child) => {
      if (request.method === "initialize") child.succeed(request.id, initialize, true);
      if (request.method === "session/resume") child.succeed(request.id, resumeResult);
    });

    const report = await probeKimiAcp({ ...harness.options, sessionId: "kimi-existing" });

    expect(harness.calls).toEqual([
      {
        command: "kimi",
        args: ["acp"],
        options: expect.objectContaining({ cwd, stdio: ["pipe", "pipe", "pipe"] }),
      },
    ]);
    expect(harness.child.requests.map((request) => request.method)).toEqual([
      "initialize",
      "session/resume",
    ]);
    expect(harness.child.requests[0]?.params).toMatchObject({ protocolVersion: 2 });
    expect(harness.child.requests[1]?.params).toEqual({
      sessionId: "kimi-existing",
      cwd,
      mcpServers: [],
    });
    expect(report).toEqual({
      kimiVersion: "1.2.3",
      observedAt,
      initialize,
      resumeResult,
      activeDeliveryClaim: false,
      reason: "existing-tui-interaction-not-verified",
    });
    expect(harness.child.kill).toHaveBeenCalledTimes(1);
  });

  it("uses the ACP v2 session baseline as resume support", async () => {
    const initialize = {
      protocolVersion: 2,
      info: { name: "Kimi Code", version: "2.0.0" },
      capabilities: { session: {} },
    };
    const harness = fakeProbe((request, child) => {
      if (request.method === "initialize") child.succeed(request.id, initialize);
      if (request.method === "session/resume") child.succeed(request.id, { resumed: true });
    });

    const report = await probeKimiAcp({ ...harness.options, sessionId: "kimi-v2" });

    expect(harness.child.requests.map((request) => request.method)).toEqual([
      "initialize",
      "session/resume",
    ]);
    expect(report).toMatchObject({
      kimiVersion: "2.0.0",
      initialize,
      resumeResult: { resumed: true },
      activeDeliveryClaim: false,
      reason: "existing-tui-interaction-not-verified",
    });
    expect(harness.child.kill).toHaveBeenCalledTimes(1);
  });

  it("ignores an agent request whose ID collides with the pending resume ID", async () => {
    const initialize = {
      protocolVersion: 2,
      info: { name: "Kimi Code", version: "2.0.0" },
      capabilities: { session: {} },
    };
    const resumeResult = { resumed: "after-agent-request" };
    const harness = fakeProbe((request, child) => {
      if (request.method === "initialize") child.succeed(request.id, initialize);
      if (request.method === "session/resume") {
        child.stdout.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            method: "session/request_permission",
            params: { sessionId: "kimi-request-id" },
          })}\n`,
        );
        child.succeed(request.id, resumeResult);
      }
    });

    const report = await probeKimiAcp({ ...harness.options, sessionId: "kimi-request-id" });

    expect(report.initialize).toEqual(initialize);
    expect(report.resumeResult).toEqual(resumeResult);
    expect(harness.child.kill).toHaveBeenCalledTimes(1);
  });

  it("skips resume when ACP v1 advertises load but not resume", async () => {
    const initialize = {
      protocolVersion: 1,
      agentInfo: { name: "Kimi Code", version: "1.2.3" },
      agentCapabilities: { loadSession: true, sessionCapabilities: {} },
    };
    const harness = fakeProbe((request, child) => {
      if (request.method === "initialize") child.succeed(request.id, initialize);
    });

    const report = await probeKimiAcp({ ...harness.options, sessionId: "kimi-v1-load-only" });

    expect(report.resumeSkippedReason).toBe("resume-unsupported");
    expect(report).not.toHaveProperty("resumeResult");
    expect(harness.child.requests.map((request) => request.method)).toEqual(["initialize"]);
    expect(harness.child.kill).toHaveBeenCalledTimes(1);
  });

  it("does not reuse a v1 resume marker after negotiating ACP v2", async () => {
    const initialize = {
      protocolVersion: 2,
      info: { name: "Kimi Code", version: "2.0.0" },
      capabilities: {},
      agentCapabilities: { sessionCapabilities: { resume: {} } },
    };
    const harness = fakeProbe((request, child) => {
      if (request.method === "initialize") child.succeed(request.id, initialize);
    });

    const report = await probeKimiAcp({ ...harness.options, sessionId: "kimi-v2-no-session" });

    expect(report.resumeSkippedReason).toBe("resume-unsupported");
    expect(harness.child.requests.map((request) => request.method)).toEqual(["initialize"]);
    expect(harness.child.kill).toHaveBeenCalledTimes(1);
  });

  it("records why resume was skipped without an explicit session ID", async () => {
    const initialize = {
      protocolVersion: 1,
      agentInfo: { name: "Kimi Code", version: "1.2.3" },
      agentCapabilities: { sessionCapabilities: { resume: {} } },
    };
    const harness = fakeProbe((request, child) => {
      if (request.method === "initialize") child.succeed(request.id, initialize);
    });

    const report = await probeKimiAcp(harness.options);

    expect(report.resumeSkippedReason).toBe("session-id-not-provided");
    expect(harness.child.requests.map((request) => request.method)).toEqual(["initialize"]);
    expect(harness.child.kill).toHaveBeenCalledTimes(1);
  });

  it("fails closed for an unsupported negotiated protocol version", async () => {
    const initialize = {
      protocolVersion: 99,
      info: { name: "Kimi Code", version: "99.0.0" },
      capabilities: { session: {} },
      agentCapabilities: { sessionCapabilities: { resume: {} } },
    };
    const harness = fakeProbe((request, child) => {
      if (request.method === "initialize") child.succeed(request.id, initialize);
    });

    const report = await probeKimiAcp({ ...harness.options, sessionId: "kimi-unknown-version" });

    expect(report.resumeSkippedReason).toBe("unsupported-protocol-version");
    expect(harness.child.requests.map((request) => request.method)).toEqual(["initialize"]);
    expect(harness.child.kill).toHaveBeenCalledTimes(1);
  });

  it("times out initialize after five seconds and terminates the child", async () => {
    vi.useFakeTimers();
    const harness = fakeProbe(() => {});

    const probing = probeKimiAcp(harness.options);
    const rejection = expect(probing).rejects.toThrow("initialize timed out after 5000 ms");
    await vi.advanceTimersByTimeAsync(5000);

    await rejection;
    expect(harness.child.requests.map((request) => request.method)).toEqual(["initialize"]);
    expect(harness.child.kill).toHaveBeenCalledTimes(1);
  });

  it("times out resume after five seconds and terminates the child", async () => {
    vi.useFakeTimers();
    const initialize = {
      protocolVersion: 1,
      agentInfo: { name: "Kimi Code", version: "1.2.3" },
      agentCapabilities: { sessionCapabilities: { resume: {} } },
    };
    const harness = fakeProbe((request, child) => {
      if (request.method === "initialize") child.succeed(request.id, initialize);
    });

    const probing = probeKimiAcp({ ...harness.options, sessionId: "kimi-timeout" });
    const rejection = expect(probing).rejects.toThrow("session/resume timed out after 5000 ms");
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.child.requests.map((request) => request.method)).toEqual([
      "initialize",
      "session/resume",
    ]);
    await vi.advanceTimersByTimeAsync(5000);

    await rejection;
    expect(harness.child.kill).toHaveBeenCalledTimes(1);
  });

  it("terminates the child after a JSON-RPC failure", async () => {
    const harness = fakeProbe((request, child) => {
      if (request.method === "initialize") child.fail(request.id, -32022, "unsupported version");
    });

    await expect(probeKimiAcp(harness.options)).rejects.toThrow(
      "initialize failed: unsupported version",
    );
    expect(harness.child.kill).toHaveBeenCalledTimes(1);
  });
});

const message: Message = {
  id: "kimi-message",
  project: "verdicta",
  from: "cto",
  to: "arch",
  text: "Read this through the MCP inbox",
  expectsReply: false,
  idempotencyKey: "kimi-message",
  threadId: "kimi-thread",
  createdAt: "2026-11-10T00:00:00.000Z",
  deliveryState: "stored",
};

const kimiSession: AdapterSession = {
  project: "verdicta",
  agentId: "arch",
  sessionId: "kimi-session",
  protocolVersion: PROTOCOL_VERSION,
  capabilities: {
    activeDelivery: false,
    stateReporting: false,
    clientIdempotency: false,
  },
  state: "unknown",
  lastHeartbeatAt: "2026-11-10T00:00:00.000Z",
  stateObservedAt: "2026-11-10T00:00:00.000Z",
  leaseExpiresAt: "2026-11-10T00:00:15.000Z",
};

describe("KimiFallbackAdapter", () => {
  it("supports MCP inbox without claiming active delivery", async () => {
    const adapter = new KimiFallbackAdapter();

    expect(adapter.capabilities).toEqual({
      activeDelivery: false,
      stateReporting: false,
      clientIdempotency: false,
    });
    await expect(adapter.state("kimi-session")).resolves.toBe("unknown");
    await expect(adapter.state("another-kimi-session")).resolves.toBe("unknown");
    await expect(adapter.submit("kimi-session", message)).rejects.toMatchObject({
      code: "DELIVERY_UNCERTAIN",
    });
    expect(inactiveReason(kimiSession)).toBe("active-delivery-unsupported");
  });

  it("rejects submission before inspecting message or client data", async () => {
    const adapter = new KimiFallbackAdapter();
    const inaccessibleMessage = new Proxy(
      {},
      {
        get() {
          throw new Error("message data must not be inspected");
        },
      },
    ) as Message;

    await expect(adapter.submit("kimi-session", inaccessibleMessage)).rejects.toMatchObject({
      code: "DELIVERY_UNCERTAIN",
    });
  });
});
