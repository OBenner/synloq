import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Notification } from "@modelcontextprotocol/sdk/types.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runClaudeAdapter } from "../../src/adapters/claude-channel.js";
import { frameMessage } from "../../src/adapters/reference.js";
import { runClaudeHook } from "../../src/cli/claude-hook.js";
import { CredentialStore } from "../../src/config/credentials.js";
import type { Participant } from "../../src/domain/message.js";
import { PROTOCOL_VERSION } from "../../src/domain/session.js";
import { Dispatcher } from "../../src/relay/dispatcher.js";
import { ProtectionPolicy } from "../../src/relay/protection.js";
import { RelayService } from "../../src/relay/relay-service.js";
import { SQLiteMessageStore } from "../../src/storage/message-store.js";
import { SessionStore } from "../../src/storage/session-store.js";
import { RelayHttpClient } from "../../src/transport/http-client.js";
import { RelayHttpServer } from "../../src/transport/http-server.js";

const PROJECT = "verdicta";
const SESSION_ID = "claude-entrypoint-session";
const participants: Participant[] = [
  { project: PROJECT, agentId: "cto", title: "CTO", role: "Architecture" },
  { project: PROJECT, agentId: "arch", title: "Architect", role: "Review" },
];

let root: string;
let home: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "synloq-claude-entry-project-"));
  home = await mkdtemp(join(tmpdir(), "synloq-claude-entry-home-"));
  vi.stubEnv("SYNLOQ_HOME", home);
});

afterEach(async () => {
  await Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(home, { recursive: true, force: true }),
  ]);
  vi.unstubAllEnvs();
});

function hookInput(event: string, prompt?: string): Readable {
  return Readable.from([
    JSON.stringify({
      session_id: SESSION_ID,
      hook_event_name: event,
      ...(prompt === undefined ? {} : { prompt }),
    }),
  ]);
}

describe("Claude composition entry points", () => {
  it("uses real hook heartbeat state for dispatch and submitted-message delivery evidence", async () => {
    const credentials = new CredentialStore(root);
    const ctoToken = await credentials.issue(PROJECT, "cto");
    const archToken = await credentials.issue(PROJECT, "arch");
    const messages = new SQLiteMessageStore(":memory:");
    const sessions = new SessionStore(":memory:");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const running = await runClaudeAdapter(
      {
        sessionId: SESSION_ID,
        protocolVersion: PROTOCOL_VERSION,
        activationVerifiedAt: "2026-11-10T00:00:00.000Z",
      },
      serverTransport,
    );
    const mcpClient = new Client(
      { name: "entrypoint-mock-claude", version: "0.0.0" },
      { capabilities: {} },
    );
    const notifications: Notification[] = [];
    mcpClient.fallbackNotificationHandler = async (notification) => {
      notifications.push(notification);
    };
    await mcpClient.connect(clientTransport);

    const dispatcher = new Dispatcher(
      messages,
      sessions,
      new Map([[`${PROJECT}/arch`, running.adapter]]),
    );
    const server = new RelayHttpServer({
      project: PROJECT,
      relay: new RelayService(participants, messages, sessions, new ProtectionPolicy(messages)),
      credentials,
      sessions,
      dispatcher,
      messages,
    });
    const baseUrl = await server.listen("127.0.0.1", 0);
    const cto = new RelayHttpClient(baseUrl, () => ctoToken);
    const arch = new RelayHttpClient(baseUrl, () => archToken);

    try {
      await arch.registerSession({
        sessionId: SESSION_ID,
        protocolVersion: PROTOCOL_VERSION,
        capabilities: running.adapter.capabilities,
      });
      await runClaudeHook(
        arch,
        { project: PROJECT, agentId: "arch", sessionId: SESSION_ID },
        { stdin: hookInput("SessionStart") },
      );
      expect(sessions.effectiveState(PROJECT, "arch")).toBe("idle");

      const { message } = await cto.send({
        to: "arch",
        text: "Use the authoritative relay heartbeat",
        expectsReply: false,
        idempotencyKey: "claude-entrypoint-1",
      });
      await dispatcher.runOnce(PROJECT, "arch");

      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toMatchObject({
        method: "notifications/claude/channel",
        params: { content: frameMessage(message) },
      });
      expect(messages.getMessage(message.id)?.deliveryState).toBe("submitted");

      await runClaudeHook(
        arch,
        { project: PROJECT, agentId: "arch", sessionId: SESSION_ID },
        { stdin: hookInput("UserPromptSubmit", frameMessage(message)) },
      );
      expect(messages.getMessage(message.id)?.deliveryState).toBe("delivered");
    } finally {
      await server.close();
      await mcpClient.close();
      await running.server.close();
      sessions.close();
      messages.close();
    }
  });
});
