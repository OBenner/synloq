import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Notification } from "@modelcontextprotocol/sdk/types.js";
import type { OpencodeClient } from "@opencode-ai/sdk/client";
import type { OpencodeClient as OpenCodeV2Client } from "@opencode-ai/sdk/v2/client";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { frameMessage } from "../../src/adapters/reference.js";
import {
  runStandaloneClaudeHook,
  startStandaloneAdapter,
  type StandaloneAdapterHandle,
} from "../../src/cli/adapter.js";
import { initCommand, serveCommand, type ServeHandle } from "../../src/cli/commands.js";
import { runMain, type CliIo } from "../../src/cli/main.js";
import { PROTOCOL_VERSION } from "../../src/domain/session.js";
import { RelayHttpClient } from "../../src/transport/http-client.js";

const PROJECT = "verdicta";
const CLAUDE_SESSION = "claude-visible-cto";
const OPENCODE_SESSION = "opencode-visible-arch";
const manifest = `project: verdicta
agents:
  cto:
    title: CTO
    role: Architecture
  arch:
    title: Architect
    role: Review
`;

const closers: Array<() => Promise<void>> = [];
const directories: string[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
  vi.unstubAllEnvs();
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

async function fixture() {
  const root = await temporaryDirectory("synloq-standalone-project-");
  const home = await temporaryDirectory("synloq-standalone-home-");
  vi.stubEnv("SYNLOQ_HOME", home);
  await writeFile(join(root, "synloq.yaml"), manifest);
  const initialized = await initCommand({ projectRoot: root });
  const tokens = new Map(
    initialized.credentials.map((credential) => [credential.agentId, credential.token]),
  );
  const ctoToken = tokens.get("cto");
  const archToken = tokens.get("arch");
  if (!ctoToken || !archToken) throw new Error("missing test credentials");
  const ctoCredentialPath = join(home, "cto.token");
  const archCredentialPath = join(home, "arch.token");
  await writeFile(ctoCredentialPath, `${ctoToken}\n`, { mode: 0o600 });
  await writeFile(archCredentialPath, `${archToken}\n`, { mode: 0o600 });
  const relay = await serveCommand({ projectRoot: root });
  closers.push(() => relay.close());
  return {
    root,
    home,
    relay,
    ctoCredentialPath,
    archCredentialPath,
    cto: new RelayHttpClient(relay.baseUrl, () => ctoToken),
    arch: new RelayHttpClient(relay.baseUrl, () => archToken),
  };
}

interface ConfigInput {
  root: string;
  relay: ServeHandle;
  credentialPath: string;
  kind: "claude" | "opencode";
  agentId: "cto" | "arch";
  sessionId: string;
  acceptanceMessageId?: string;
  baseUrl?: string;
}

async function writeConfig(home: string, input: ConfigInput): Promise<string> {
  const configPath = join(home, `${input.kind}-${input.agentId}.json`);
  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      kind: input.kind,
      project: PROJECT,
      projectRoot: input.root,
      agentId: input.agentId,
      sessionId: input.sessionId,
      relayUrl: input.relay.baseUrl,
      credentialPath: input.credentialPath,
      protocolVersion: PROTOCOL_VERSION,
      ...(input.acceptanceMessageId ? { acceptanceMessageId: input.acceptanceMessageId } : {}),
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
      ...(input.kind === "opencode" ? { heartbeatIntervalMs: 5 } : {}),
    }),
  );
  return configPath;
}

async function connectClaude(
  configPath: string,
  activeDelivery = false,
): Promise<{
  handle: StandaloneAdapterHandle;
  client: Client;
  notifications: Notification[];
}> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const starting = startStandaloneAdapter(configPath, {
    claudeTransport: serverTransport,
    deliveryWaitMs: 5,
  });
  const client = new Client(
    { name: "controlled-claude", version: "0.0.0" },
    {
      capabilities: activeDelivery
        ? {
            experimental: {
              "claude/channel": {},
              "claude/channel/permission": {},
            },
          }
        : {},
    },
  );
  const notifications: Notification[] = [];
  client.fallbackNotificationHandler = async (notification) => {
    notifications.push(notification);
  };
  await client.connect(clientTransport);
  const handle = await starting;
  closers.push(
    () => handle.close(),
    () => client.close(),
  );
  return { handle, client, notifications };
}

class FakeEventStream implements AsyncIterable<unknown> {
  private ended = false;
  private readonly waiters: Array<(result: IteratorResult<unknown>) => void> = [];

  get isEnded(): boolean {
    return this.ended;
  }

  next(): Promise<IteratorResult<unknown>> {
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  return(): Promise<IteratorResult<unknown>> {
    this.end();
    return Promise.resolve({ value: undefined, done: true });
  }

  end(): void {
    this.ended = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this;
  }
}

function fakeOpenCode(sessionId: string) {
  const stream = new FakeEventStream();
  const prompt = vi.fn(
    async (parameters: {
      sessionID: string;
      prompt: { text: string };
      delivery: "queue";
      resume: false;
    }) => ({
      data: {
        data: {
          admittedSeq: 1,
          id: "opencode-admission-1",
          sessionID: parameters.sessionID,
          prompt: parameters.prompt,
          delivery: "queue" as const,
          timeCreated: 1,
        },
      },
    }),
  );
  const status = vi.fn(async () => ({
    data: { [sessionId]: { type: "idle" } },
  }));
  const subscribe = vi.fn((options?: { signal?: AbortSignal }) => {
    options?.signal?.addEventListener("abort", () => stream.end(), {
      once: true,
    });
    return Promise.resolve({ stream });
  });
  return {
    prompt,
    status,
    stream,
    clients: {
      openCode: { v2: { session: { prompt } } } as unknown as OpenCodeV2Client,
      client: {
        session: { status },
        event: { subscribe },
      } as unknown as OpencodeClient,
    },
  };
}

describe("standalone real-client composition", () => {
  it("registers a disabled Claude session and exposes exactly six ordinary tools", async () => {
    const current = await fixture();
    const configPath = await writeConfig(current.home, {
      root: current.root,
      relay: current.relay,
      credentialPath: current.ctoCredentialPath,
      kind: "claude",
      agentId: "cto",
      sessionId: CLAUDE_SESSION,
    });
    const { handle, client } = await connectClaude(configPath);

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "synloq_ack",
      "synloq_inbox",
      "synloq_list",
      "synloq_reply",
      "synloq_send",
      "synloq_wait",
    ]);
    expect(current.relay.sessions.list(PROJECT)).toMatchObject([
      {
        agentId: "cto",
        sessionId: CLAUDE_SESSION,
        protocolVersion: 1,
        capabilities: {
          activeDelivery: false,
          stateReporting: true,
          clientIdempotency: true,
        },
      },
    ]);

    await handle.close();
    expect(current.relay.sessions.list(PROJECT)[0]?.state).toBe("closed");
  });

  it("runs controlled Claude acceptance through the real relay and hook entry point", async () => {
    const current = await fixture();
    const { message } = await current.arch.send({
      to: "cto",
      text: "Accept this one visible Claude message",
      expectsReply: false,
      idempotencyKey: "standalone-claude-acceptance-1",
    });
    const configPath = await writeConfig(current.home, {
      root: current.root,
      relay: current.relay,
      credentialPath: current.ctoCredentialPath,
      kind: "claude",
      agentId: "cto",
      sessionId: CLAUDE_SESSION,
      acceptanceMessageId: message.id,
    });
    const { notifications } = await connectClaude(configPath, true);
    expect(current.relay.sessions.list(PROJECT)[0]?.generation).toBe(1);
    await runStandaloneClaudeHook(configPath, {
      stdin: Readable.from([
        JSON.stringify({
          session_id: CLAUDE_SESSION,
          hook_event_name: "SessionStart",
        }),
      ]),
    });

    await vi.waitFor(
      () => {
        expect(notifications).toHaveLength(1);
      },
      { timeout: 1_000, interval: 1 },
    );
    expect(notifications[0]).toMatchObject({
      method: "notifications/claude/channel",
      params: {
        content: frameMessage(message, 1),
        meta: { message: message.id, thread: message.threadId },
      },
    });
    expect(current.relay.messages.getMessage(message.id)?.deliveryState).toBe("submitted");

    await runStandaloneClaudeHook(configPath, {
      stdin: Readable.from([
        JSON.stringify({
          session_id: CLAUDE_SESSION,
          hook_event_name: "UserPromptSubmit",
          prompt: frameMessage(message, 1),
        }),
      ]),
    });
    expect(current.relay.messages.getMessage(message.id)?.deliveryState).toBe("delivered");
  });

  it("composes OpenCode queue admission, receipts, exact binding, and shutdown", async () => {
    const current = await fixture();
    const sdk = fakeOpenCode(OPENCODE_SESSION);
    const configPath = await writeConfig(current.home, {
      root: current.root,
      relay: current.relay,
      credentialPath: current.archCredentialPath,
      kind: "opencode",
      agentId: "arch",
      sessionId: OPENCODE_SESSION,
      baseUrl: "http://127.0.0.1:4096",
    });
    const handle = await startStandaloneAdapter(configPath, {
      openCodeClients: sdk.clients,
      deliveryWaitMs: 5,
    });
    closers.push(() => handle.close());
    const { message } = await current.cto.send({
      to: "arch",
      text: "Queue this visible OpenCode message",
      expectsReply: false,
      idempotencyKey: "standalone-opencode-1",
    });

    await vi.waitFor(
      () => {
        expect(sdk.prompt).toHaveBeenCalledTimes(1);
        expect(current.relay.messages.getMessage(message.id)?.deliveryState).toBe("delivered");
      },
      { timeout: 1_000, interval: 1 },
    );
    expect(sdk.prompt).toHaveBeenCalledWith(
      {
        sessionID: OPENCODE_SESSION,
        prompt: { text: frameMessage(message) },
        delivery: "queue",
        resume: false,
      },
      { throwOnError: true },
    );
    expect(current.relay.sessions.list(PROJECT)[0]).toMatchObject({
      agentId: "arch",
      sessionId: OPENCODE_SESSION,
      protocolVersion: 1,
    });

    await handle.close();
    expect(sdk.stream.isEnded).toBe(true);
    expect(current.relay.sessions.list(PROJECT)[0]?.state).toBe("closed");
  });
});

function testIo(): {
  io: CliIo;
  output: () => { stdout: string; stderr: string };
} {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: {
        write(chunk) {
          stdout += String(chunk);
          return true;
        },
      },
      stderr: {
        write(chunk) {
          stderr += String(chunk);
          return true;
        },
      },
    },
    output: () => ({ stdout, stderr }),
  };
}

describe("standalone adapter CLI", () => {
  it.each(["adapter", "claude-hook", "codex-hook"])(
    "prints %s help without loading configuration",
    async (command) => {
      const { io, output } = testIo();

      await expect(runMain([command, "--help"], io)).resolves.toBe(0);
      expect(output().stdout).toContain("--config");
      expect(output().stderr).toBe("");
    },
  );

  it("closes the adapter after shutdown without writing protocol stdout", async () => {
    const { io, output } = testIo();
    const close = vi.fn().mockResolvedValue(undefined);
    let observedConfig = "";

    await expect(
      runMain(["adapter", "--config", "/tmp/adapter.json"], io, {
        startAdapter: async (configPath) => {
          observedConfig = configPath;
          return {
            kind: "claude",
            agentId: "cto",
            sessionId: CLAUDE_SESSION,
            closed: Promise.resolve(),
            close,
          };
        },
        waitForShutdown: async () => undefined,
      }),
    ).resolves.toBe(0);
    expect(observedConfig).toBe("/tmp/adapter.json");
    expect(close).toHaveBeenCalledTimes(1);
    expect(output()).toEqual({ stdout: "", stderr: "" });
  });

  it("invokes the public hook command without writing a permission decision", async () => {
    const { io, output } = testIo();
    const runHook = vi.fn().mockResolvedValue(undefined);

    await expect(
      runMain(["claude-hook", "--config", "/tmp/claude.json"], io, { runHook }),
    ).resolves.toBe(0);
    expect(runHook).toHaveBeenCalledWith("/tmp/claude.json");
    expect(output()).toEqual({ stdout: "", stderr: "" });
  });
});
