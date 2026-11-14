import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startMcpStdio } from "../../src/mcp/stdio.js";

class TestStdioClientTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private buffered = "";

  constructor(
    private readonly reader: PassThrough,
    private readonly writer: PassThrough,
  ) {}

  async start(): Promise<void> {
    this.reader.on("data", this.read);
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.writer.write(`${JSON.stringify(message)}\n`);
  }

  async close(): Promise<void> {
    this.reader.off("data", this.read);
    this.writer.end();
    this.onclose?.();
  }

  private readonly read = (chunk: Buffer): void => {
    this.buffered += chunk.toString("utf8");
    for (;;) {
      const newline = this.buffered.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffered.slice(0, newline);
      this.buffered = this.buffered.slice(newline + 1);
      if (line !== "") this.onmessage?.(JSON.parse(line) as JSONRPCMessage);
    }
  };
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, recursiveOptions)));
});

const recursiveOptions = { recursive: true, force: true } as const;

async function configuration(): Promise<{ root: string; configPath: string; token: string }> {
  const root = await mkdtemp(join(tmpdir(), "synloq-mcp-stdio-"));
  roots.push(root);
  const token = "stdio-secret-token";
  const credentialPath = join(root, "agent.token");
  const configPath = join(root, "mcp.json");
  await writeFile(credentialPath, `${token}\n`, { mode: 0o600 });
  await writeFile(
    configPath,
    JSON.stringify({ relayUrl: "http://127.0.0.1:49152", credentialPath }),
  );
  return { root, configPath, token };
}

describe("Synloq MCP stdio bridge", () => {
  it("serves the six tools over real stdio streams without leaking the credential", async () => {
    const { configPath, token } = await configuration();
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    let diagnostics = "";
    let protocolOutput = "";
    serverToClient.on("data", (chunk: Buffer) => {
      protocolOutput += chunk.toString("utf8");
    });
    const stderr = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        diagnostics += chunk.toString("utf8");
        callback();
      },
    });
    const server = await startMcpStdio(configPath, {
      stdin: clientToServer,
      stdout: serverToClient,
      stderr,
    });
    const client = new Client({ name: "stdio-test-client", version: "0.1.0" });

    try {
      await client.connect(new TestStdioClientTransport(serverToClient, clientToServer));
      const { tools } = await client.listTools();

      expect(tools.map((tool) => tool.name).sort()).toEqual([
        "synloq_ack",
        "synloq_inbox",
        "synloq_list",
        "synloq_reply",
        "synloq_send",
        "synloq_wait",
      ]);
      expect(diagnostics).toContain("ready");
      // Every diagnostic line carries an ISO 8601 UTC timestamp (issue #24).
      expect(diagnostics).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z Synloq MCP stdio bridge ready$/m,
      );
      expect(diagnostics).not.toContain(token);
      expect(protocolOutput).not.toContain(token);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("starts and closes one visible-delivery bridge for an optional binding", async () => {
    const { root, configPath } = await configuration();
    await writeFile(
      configPath,
      JSON.stringify({
        relayUrl: "http://127.0.0.1:49152",
        credentialPath: join(root, "agent.token"),
        kimiWork: {
          projectRoot: root,
          agentId: "arch",
          conversationKey: "agent:main:main:conversation:d7be2b2c-edfc-4fc7-a010-1e7af6465138",
          workAgentId: "main",
        },
      }),
    );
    const bridge = {
      runner: { start: vi.fn(), close: vi.fn(async () => undefined) },
      adapter: { close: vi.fn(async () => undefined) },
    };
    const kimiWorkFactory = vi.fn(async () => bridge);
    const server = await startMcpStdio(configPath, {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new Writable({ write: (_chunk, _encoding, callback) => callback() }),
      kimiWorkFactory,
    });

    await vi.waitFor(() => expect(bridge.runner.start).toHaveBeenCalledTimes(1));
    expect(kimiWorkFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: expect.objectContaining({
          conversationKey: "agent:main:main:conversation:d7be2b2c-edfc-4fc7-a010-1e7af6465138",
          workspacePath: root,
        }),
      }),
    );
    await server.close();
    await vi.waitFor(() => {
      expect(bridge.runner.close).toHaveBeenCalledTimes(1);
      expect(bridge.adapter.close).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps MCP available after sanitized host startup failure", async () => {
    const { root, configPath, token } = await configuration();
    await writeFile(
      configPath,
      JSON.stringify({
        relayUrl: "http://127.0.0.1:49152",
        credentialPath: join(root, "agent.token"),
        kimiWork: {
          projectRoot: root,
          agentId: "arch",
          conversationKey: "agent:main:main:conversation:d7be2b2c-edfc-4fc7-a010-1e7af6465138",
        },
      }),
    );
    let diagnostics = "";
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    const server = await startMcpStdio(configPath, {
      stdin: clientToServer,
      stdout: serverToClient,
      stderr: new Writable({
        write(chunk: Buffer, _encoding, callback) {
          diagnostics += chunk.toString("utf8");
          callback();
        },
      }),
      kimiWorkFactory: async () => {
        throw new Error(`private ${token}`);
      },
      kimiWorkStartupAttempts: 1,
    });
    const client = new Client({ name: "stdio-test-client", version: "0.1.0" });

    try {
      await client.connect(new TestStdioClientTransport(serverToClient, clientToServer));
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(6);
      await vi.waitFor(() => expect(diagnostics).toContain("visible delivery unavailable"));
      expect(diagnostics).not.toContain(token);
      expect(diagnostics.match(/visible delivery unavailable/g)).toHaveLength(1);
      // The failure trail is timestamped: startup failure and the final
      // unavailability line both carry ISO 8601 UTC prefixes (issue #24).
      expect(diagnostics).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z Synloq Kimi Work startup attempt 1\/1 failed/m,
      );
      expect(diagnostics).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z Synloq Kimi Work visible delivery unavailable/m,
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("retries startup without creating a second registration after success", async () => {
    const { root, configPath } = await configuration();
    await writeFile(
      configPath,
      JSON.stringify({
        relayUrl: "http://127.0.0.1:49152",
        credentialPath: join(root, "agent.token"),
        kimiWork: {
          projectRoot: root,
          agentId: "arch",
          conversationKey: "agent:main:main:conversation:d7be2b2c-edfc-4fc7-a010-1e7af6465138",
        },
      }),
    );
    const bridge = {
      runner: { start: vi.fn(), close: vi.fn(async () => undefined) },
      adapter: { close: vi.fn(async () => undefined) },
    };
    const kimiWorkFactory = vi
      .fn()
      .mockRejectedValueOnce(new Error("host offline"))
      .mockResolvedValue(bridge);
    const server = await startMcpStdio(configPath, {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new Writable({ write: (_chunk, _encoding, callback) => callback() }),
      kimiWorkFactory,
      kimiWorkStartupAttempts: 2,
      kimiWorkRetryDelayMs: 1,
    });

    await vi.waitFor(() => expect(bridge.runner.start).toHaveBeenCalledTimes(1));
    expect(kimiWorkFactory).toHaveBeenCalledTimes(2);
    await server.close();
  });

  it("restarts the visible-delivery bridge when the runner reports a stale binding", async () => {
    const { root, configPath } = await configuration();
    await writeFile(
      configPath,
      JSON.stringify({
        relayUrl: "http://127.0.0.1:49152",
        credentialPath: join(root, "agent.token"),
        kimiWork: {
          projectRoot: root,
          agentId: "arch",
          conversationKey: "agent:main:main:conversation:d7be2b2c-edfc-4fc7-a010-1e7af6465138",
          workAgentId: "main",
        },
      }),
    );
    const bridges = [
      {
        runner: { start: vi.fn(), close: vi.fn(async () => undefined) },
        adapter: { close: vi.fn(async () => undefined) },
      },
      {
        runner: { start: vi.fn(), close: vi.fn(async () => undefined) },
        adapter: { close: vi.fn(async () => undefined) },
      },
    ];
    const kimiWorkFactory = vi
      .fn()
      .mockResolvedValueOnce(bridges[0])
      .mockResolvedValueOnce(bridges[1]);
    let diagnostics = "";
    const server = await startMcpStdio(configPath, {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new Writable({
        write(chunk: Buffer, _encoding, callback) {
          diagnostics += chunk.toString("utf8");
          callback();
        },
      }),
      kimiWorkFactory,
    });

    await vi.waitFor(() => expect(bridges[0]!.runner.start).toHaveBeenCalledTimes(1));
    const onUnauthorized = (bridges[0]!.runner as { onUnauthorized?: unknown }).onUnauthorized;
    expect(typeof onUnauthorized).toBe("function");
    (onUnauthorized as (error: unknown) => void)(
      Object.assign(new Error("session generation is stale"), { code: "UNAUTHORIZED" }),
    );

    await vi.waitFor(() => expect(bridges[1]!.runner.start).toHaveBeenCalledTimes(1));
    expect(kimiWorkFactory).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => {
      expect(bridges[0]!.runner.close).toHaveBeenCalledTimes(1);
      expect(bridges[0]!.adapter.close).toHaveBeenCalledTimes(1);
    });
    expect(diagnostics).toContain("re-registering");
    await server.close();
  });

  it("runs exactly one recovery when runner and heartbeat report a stale binding concurrently", async () => {
    const { root, configPath } = await configuration();
    await writeFile(
      configPath,
      JSON.stringify({
        relayUrl: "http://127.0.0.1:49152",
        credentialPath: join(root, "agent.token"),
        kimiWork: {
          projectRoot: root,
          agentId: "arch",
          conversationKey: "agent:main:main:conversation:d7be2b2c-edfc-4fc7-a010-1e7af6465138",
          workAgentId: "main",
        },
      }),
    );
    const bridges = [
      {
        runner: { start: vi.fn(), close: vi.fn(async () => undefined) },
        adapter: { close: vi.fn(async () => undefined) },
      },
      {
        runner: { start: vi.fn(), close: vi.fn(async () => undefined) },
        adapter: { close: vi.fn(async () => undefined) },
      },
    ];
    const kimiWorkFactory = vi
      .fn()
      .mockResolvedValueOnce(bridges[0])
      .mockResolvedValueOnce(bridges[1]);
    const server = await startMcpStdio(configPath, {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new Writable({ write: (_chunk, _encoding, callback) => callback() }),
      kimiWorkFactory,
    });

    await vi.waitFor(() => expect(bridges[0]!.runner.start).toHaveBeenCalledTimes(1));
    const factoryOptions = kimiWorkFactory.mock.calls[0]![0] as {
      onUnauthorized?: (error: unknown) => void;
    };
    expect(typeof factoryOptions.onUnauthorized).toBe("function");
    const runnerCallback = (bridges[0]!.runner as { onUnauthorized?: (error: unknown) => void })
      .onUnauthorized!;
    const stale = Object.assign(new Error("session generation is stale"), {
      code: "UNAUTHORIZED",
    });

    // Runner loop and adapter heartbeat may detect the stale generation at the
    // same time; both paths funnel into one single-flight recovery.
    runnerCallback(stale);
    factoryOptions.onUnauthorized!(stale);
    factoryOptions.onUnauthorized!(stale);

    await vi.waitFor(() => expect(bridges[1]!.runner.start).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(kimiWorkFactory).toHaveBeenCalledTimes(2);
    await server.close();
  });

  it("throttles recovery storms beyond the configured limit and cools down", async () => {
    const { root, configPath } = await configuration();
    await writeFile(
      configPath,
      JSON.stringify({
        relayUrl: "http://127.0.0.1:49152",
        credentialPath: join(root, "agent.token"),
        kimiWork: {
          projectRoot: root,
          agentId: "arch",
          conversationKey: "agent:main:main:conversation:d7be2b2c-edfc-4fc7-a010-1e7af6465138",
          workAgentId: "main",
        },
      }),
    );
    const makeBridge = () => ({
      runner: { start: vi.fn(), close: vi.fn(async () => undefined) },
      adapter: { close: vi.fn(async () => undefined) },
    });
    const bridges = [makeBridge(), makeBridge(), makeBridge(), makeBridge()];
    const kimiWorkFactory = vi
      .fn()
      .mockResolvedValueOnce(bridges[0])
      .mockResolvedValueOnce(bridges[1])
      .mockResolvedValueOnce(bridges[2])
      .mockResolvedValue(bridges[3]);
    let diagnostics = "";
    const server = await startMcpStdio(configPath, {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new Writable({
        write(chunk: Buffer, _encoding, callback) {
          diagnostics += chunk.toString("utf8");
          callback();
        },
      }),
      kimiWorkFactory,
      kimiWorkRecoveryLimit: 2,
      kimiWorkRecoveryWindowMs: 60_000,
      kimiWorkRecoveryCooldownMs: 150,
    });

    await vi.waitFor(() => expect(bridges[0]!.runner.start).toHaveBeenCalledTimes(1));
    const stale = Object.assign(new Error("session generation is stale"), {
      code: "UNAUTHORIZED",
    });
    const reportStale = (index: number) => {
      const callback = (bridges[index]!.runner as { onUnauthorized?: (error: unknown) => void })
        .onUnauthorized;
      expect(typeof callback).toBe("function");
      callback!(stale);
    };

    reportStale(0);
    await vi.waitFor(() => expect(bridges[1]!.runner.start).toHaveBeenCalledTimes(1));
    reportStale(1);
    await vi.waitFor(() => expect(bridges[2]!.runner.start).toHaveBeenCalledTimes(1));
    expect(kimiWorkFactory).toHaveBeenCalledTimes(3);

    // The third recovery inside the window exceeds the limit: it must cool
    // down instead of immediately re-registering (issue #28).
    reportStale(2);
    await vi.waitFor(() => expect(diagnostics).toContain("recovery throttled"));
    expect(kimiWorkFactory).toHaveBeenCalledTimes(3);

    await vi.waitFor(() => expect(bridges[3]!.runner.start).toHaveBeenCalledTimes(1), {
      timeout: 2_000,
    });
    expect(kimiWorkFactory).toHaveBeenCalledTimes(4);
    await server.close();
  });

  it("rejects strict configuration without writing the credential to diagnostics", async () => {
    const { root, configPath, token } = await configuration();
    await writeFile(
      configPath,
      JSON.stringify({
        relayUrl: "http://127.0.0.1:49152",
        credentialPath: join(root, "agent.token"),
        token,
      }),
    );
    let diagnostics = "";
    const stderr = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        diagnostics += chunk.toString("utf8");
        callback();
      },
    });

    await expect(
      startMcpStdio(configPath, {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr,
      }),
    ).rejects.toMatchObject({ name: "SynloqError", code: "INVALID_INPUT" });
    expect(diagnostics).not.toContain(token);
  });
});
