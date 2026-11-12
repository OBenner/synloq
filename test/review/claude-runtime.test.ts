import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Notification } from "@modelcontextprotocol/sdk/types.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeChannelAdapter } from "../../src/adapters/claude-channel.js";
import {
  startStandaloneAdapter,
  runStandaloneClaudeHook,
  type StandaloneAdapterHandle,
} from "../../src/cli/adapter.js";
import { serveCommand, type ServeHandle } from "../../src/cli/commands.js";
import { issueTestCredentials } from "../helpers/credentials.js";
import type { Message } from "../../src/domain/message.js";
import { PROTOCOL_VERSION } from "../../src/domain/session.js";
import { RelayHttpClient } from "../../src/transport/http-client.js";
import { MutableClock } from "../adapters/contract.js";

const PROJECT = "verdicta";
const SESSION = "review-visible-claude";
const manifest = `project: verdicta
agents:
  cto:
    title: CTO
    role: Architecture
  arch:
    title: Architect
    role: Review
`;
const channelCapabilities = {
  "claude/channel": {},
  "claude/channel/permission": {},
};

interface Fixture {
  root: string;
  home: string;
  clock: MutableClock;
  relay: ServeHandle;
  arch: RelayHttpClient;
  ctoToken: string;
}

interface ClaudeConnection {
  handle: StandaloneAdapterHandle;
  client: Client;
  clientTransport: Transport;
  notifications: Notification[];
}

const fixtures: Fixture[] = [];
const connections: ClaudeConnection[] = [];

afterEach(async () => {
  for (const connection of connections.splice(0).reverse()) {
    await connection.client.close().catch(() => undefined);
    await connection.handle.close().catch(() => undefined);
  }
  for (const fixture of fixtures.splice(0).reverse()) {
    await fixture.relay.close();
    await Promise.all([
      rm(fixture.root, { recursive: true, force: true }),
      rm(fixture.home, { recursive: true, force: true }),
    ]);
  }
  vi.unstubAllEnvs();
});

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "synloq-review-claude-project-"));
  const home = await mkdtemp(join(tmpdir(), "synloq-review-claude-home-"));
  vi.stubEnv("SYNLOQ_HOME", home);
  await writeFile(join(root, "synloq.yaml"), manifest);
  const tokens = await issueTestCredentials(root);
  const ctoToken = tokens.get("cto");
  const archToken = tokens.get("arch");
  if (!ctoToken || !archToken) throw new Error("missing review Claude credentials");
  const ctoCredentialPath = join(home, "cto.token");
  await writeFile(ctoCredentialPath, `${ctoToken}\n`, { mode: 0o600 });
  const clock = new MutableClock();
  const relay = await serveCommand({ projectRoot: root, clock });
  const current = {
    root,
    home,
    clock,
    relay,
    arch: new RelayHttpClient(relay.baseUrl, () => archToken),
    ctoToken,
  };
  fixtures.push(current);
  return current;
}

async function writeConfig(
  current: Fixture,
  activation: { acceptanceMessageId?: string; production?: boolean },
): Promise<string> {
  const configPath = join(current.home, "claude-review.json");
  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      kind: "claude",
      project: PROJECT,
      projectRoot: current.root,
      agentId: "cto",
      sessionId: SESSION,
      relayUrl: current.relay.baseUrl,
      credentialPath: join(current.home, "cto.token"),
      protocolVersion: PROTOCOL_VERSION,
      ...(activation.acceptanceMessageId
        ? { acceptanceMessageId: activation.acceptanceMessageId }
        : {}),
      ...(activation.production ? { activationVerifiedAt: "2026-11-10T00:00:00.000Z" } : {}),
    }),
  );
  return configPath;
}

async function connect(
  configPath: string,
  capabilities: Record<string, object> = channelCapabilities,
): Promise<ClaudeConnection> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const starting = startStandaloneAdapter(configPath, {
    claudeTransport: serverTransport,
    deliveryWaitMs: 5,
  });
  const client = new Client(
    { name: "review-claude", version: "0.0.0" },
    { capabilities: { experimental: capabilities } },
  );
  const notifications: Notification[] = [];
  client.fallbackNotificationHandler = async (notification) => {
    notifications.push(notification);
  };
  await client.connect(clientTransport);
  const handle = await starting;
  const connection = { handle, client, clientTransport, notifications };
  connections.push(connection);
  return connection;
}

async function sessionStart(configPath: string): Promise<void> {
  await runStandaloneClaudeHook(configPath, {
    stdin: Readable.from([
      JSON.stringify({ session_id: SESSION, hook_event_name: "SessionStart" }),
    ]),
  });
}

async function send(current: Fixture, key: string): Promise<Message> {
  return (
    await current.arch.send({
      to: "cto",
      text: `Claude review ${key}`,
      expectsReply: false,
      idempotencyKey: key,
    })
  ).message;
}

async function observeQuietPeriod(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 40));
}

describe("Claude negotiated capabilities and fresh idle", () => {
  it.each([
    ["acceptance", "claude/channel"],
    ["acceptance", "claude/channel/permission"],
    ["production", "claude/channel"],
    ["production", "claude/channel/permission"],
  ] as const)("%s path injects zero notifications without %s", async (mode, missing) => {
    const current = await fixture();
    const probe = mode === "acceptance" ? await send(current, `missing-${mode}-${missing}`) : null;
    const configPath = await writeConfig(current, {
      ...(probe ? { acceptanceMessageId: probe.id } : { production: true }),
    });
    const capabilities = { ...channelCapabilities };
    delete capabilities[missing];
    const connection = await connect(configPath, capabilities);
    await sessionStart(configPath);
    const message = probe ?? (await send(current, `missing-${mode}-${missing}`));

    await observeQuietPeriod();

    expect(connection.notifications).toEqual([]);
    expect(current.relay.messages.getMessage(message.id)?.deliveryState).toBe("stored");
  });

  it("does not poll or notify after registration until fresh hook idle arrives", async () => {
    const current = await fixture();
    const probe = await send(current, "startup-requires-idle");
    const configPath = await writeConfig(current, { acceptanceMessageId: probe.id });
    const connection = await connect(configPath);

    await observeQuietPeriod();
    expect(connection.notifications).toEqual([]);
    expect(current.relay.messages.getMessage(probe.id)?.deliveryState).toBe("stored");

    await sessionStart(configPath);
    await vi.waitFor(() => expect(connection.notifications).toHaveLength(1), {
      timeout: 1_000,
      interval: 1,
    });
  });
});

describe("Claude composed transport lifecycle", () => {
  it("closes the runner and relay session on actual client-transport EOF", async () => {
    const current = await fixture();
    const configPath = await writeConfig(current, { production: true });
    const connection = await connect(configPath);
    await sessionStart(configPath);

    await connection.clientTransport.close();

    await vi.waitFor(
      () => {
        expect(current.relay.sessions.list(PROJECT)[0]?.state).toBe("closed");
      },
      { timeout: 1_000, interval: 1 },
    );
    await expect(connection.handle.closed).resolves.toBeUndefined();
  });

  it("does not reuse a consumed one-message allowance after restart and reaping", async () => {
    const current = await fixture();
    const probe = await send(current, "durable-acceptance");
    let configPath = await writeConfig(current, { acceptanceMessageId: probe.id });
    const first = await connect(configPath);
    await sessionStart(configPath);
    await vi.waitFor(() => expect(first.notifications).toHaveLength(1), {
      timeout: 1_000,
      interval: 1,
    });
    await first.handle.close();

    current.clock.advance(15_001);
    current.relay.sessions.reapExpired(current.relay.messages);
    await current.relay.close();
    current.relay = await serveCommand({ projectRoot: current.root, clock: current.clock });
    configPath = await writeConfig(current, { acceptanceMessageId: probe.id });
    const restarted = await connect(configPath);
    await sessionStart(configPath);

    await observeQuietPeriod();
    expect(first.notifications).toHaveLength(1);
    expect(restarted.notifications).toEqual([]);
    expect(current.relay.messages.getMessage(probe.id)?.deliveryState).toBe("submitted");
  });
});

describe("Claude cancellation ambiguity", () => {
  it("reports an aborted in-flight notification as uncertain instead of hanging", async () => {
    const server = { notification: vi.fn().mockImplementation(() => new Promise(() => {})) };
    const adapter = new ClaudeChannelAdapter(server as never, {
      sessionId: SESSION,
      protocolVersion: PROTOCOL_VERSION,
      activationVerifiedAt: "2026-11-10T00:00:00.000Z",
    });
    adapter.observeInitialize({ capabilities: { experimental: channelCapabilities } });
    const message: Message = {
      id: "69d2065f-46a4-4b2f-9482-f9a64f349e26",
      project: PROJECT,
      from: "arch",
      to: "cto",
      text: "Abort this ambiguous notification",
      expectsReply: false,
      idempotencyKey: "claude-abort-review",
      threadId: "thread-claude-abort-review",
      createdAt: "2026-11-10T00:00:00.000Z",
      deliveryState: "submitted",
    };
    const controller = new AbortController();
    const submission = adapter.submit(SESSION, message, {
      generation: 1,
      signal: controller.signal,
    });
    controller.abort();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("notification abort exceeded 200 ms")), 200);
    });
    try {
      await expect(Promise.race([submission, deadline])).rejects.toMatchObject({
        code: "DELIVERY_UNCERTAIN",
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  });
});
