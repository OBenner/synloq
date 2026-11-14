import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialStore } from "../../src/config/credentials.js";
import type { Participant } from "../../src/domain/message.js";
import { registerSynloqTools } from "../../src/mcp/tools.js";
import { Dispatcher } from "../../src/relay/dispatcher.js";
import { ProtectionPolicy } from "../../src/relay/protection.js";
import { RelayService } from "../../src/relay/relay-service.js";
import { SQLiteMessageStore } from "../../src/storage/message-store.js";
import { SessionStore } from "../../src/storage/session-store.js";
import { RelayHttpClient } from "../../src/transport/http-client.js";
import { RelayHttpServer } from "../../src/transport/http-server.js";

const PROJECT = "verdicta";
const participants: Participant[] = [
  { project: PROJECT, agentId: "cto", title: "CTO", role: "Architecture" },
  { project: PROJECT, agentId: "arch", title: "Architect", role: "Review" },
];

interface Fixture {
  mcpClient: Client;
  mcpServer: McpServer;
  relayServer: RelayHttpServer;
  messages: SQLiteMessageStore;
  sessions: SessionStore;
  cto: RelayHttpClient;
  root: string;
  home: string;
}

let fixture: Fixture;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "synloq-mcp-project-"));
  const home = await mkdtemp(join(tmpdir(), "synloq-mcp-home-"));
  vi.stubEnv("SYNLOQ_HOME", home);
  const credentials = new CredentialStore(root);
  const ctoToken = await credentials.issue(PROJECT, "cto");
  const archToken = await credentials.issue(PROJECT, "arch");
  const messages = new SQLiteMessageStore(":memory:");
  const sessions = new SessionStore(":memory:");
  const relay = new RelayService(participants, messages, sessions, new ProtectionPolicy(messages));
  const dispatcher = new Dispatcher(messages, sessions, new Map());
  const relayServer = new RelayHttpServer({
    project: PROJECT,
    relay,
    credentials,
    sessions,
    dispatcher,
    messages,
  });
  const baseUrl = await relayServer.listen("127.0.0.1", 0);
  const arch = new RelayHttpClient(baseUrl, () => archToken);
  const mcpServer = new McpServer({ name: "synloq-test", version: "0.1.0" });
  registerSynloqTools(mcpServer, arch);
  const mcpClient = new Client({ name: "synloq-test-client", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcpClient.connect(clientTransport), mcpServer.connect(serverTransport)]);
  fixture = {
    mcpClient,
    mcpServer,
    relayServer,
    messages,
    sessions,
    cto: new RelayHttpClient(baseUrl, () => ctoToken),
    root,
    home,
  };
});

afterEach(async () => {
  await fixture.mcpClient.close();
  await fixture.mcpServer.close();
  await fixture.relayServer.close();
  fixture.sessions.close();
  fixture.messages.close();
  await Promise.all([
    rm(fixture.root, { recursive: true, force: true }),
    rm(fixture.home, { recursive: true, force: true }),
  ]);
  vi.unstubAllEnvs();
});

describe("Synloq agent-facing MCP tools", () => {
  it("exposes only the six participant tools and no operator capabilities", async () => {
    const { tools } = await fixture.mcpClient.listTools();
    const names = tools.map((tool) => tool.name).sort();

    expect(names).toEqual([
      "synloq_ack",
      "synloq_inbox",
      "synloq_list",
      "synloq_reply",
      "synloq_send",
      "synloq_wait",
    ]);
    expect(names).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/pause|resume|register|credential|replace|doctor|session/i),
      ]),
    );
  });

  it("lists participants with JSON text and equivalent structured content", async () => {
    const result = await fixture.mcpClient.callTool({ name: "synloq_list", arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ participants });
    expect((result as { content: Array<{ type: string; text: string }> }).content).toEqual([
      { type: "text", text: JSON.stringify({ participants }) },
    ]);
  });

  it("sends with an idempotency key and returns structured message data", async () => {
    const result = await fixture.mcpClient.callTool({
      name: "synloq_send",
      arguments: {
        to: "arch",
        text: "Review storage",
        expectsReply: true,
        idempotencyKey: "mcp-1",
      },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      message: {
        project: PROJECT,
        from: "arch",
        to: "arch",
        text: "Review storage",
        deliveryState: "stored",
      },
    });
    expect(
      JSON.parse(
        (
          (result as { content: Array<{ type: string; text: string }> }).content[0] as {
            text: string;
          }
        ).text,
      ),
    ).toEqual(result.structuredContent);
  });

  it("replies in an existing thread", async () => {
    const { message: question } = await fixture.cto.send({
      to: "arch",
      text: "Question",
      expectsReply: true,
      idempotencyKey: "mcp-question-1",
    });

    const result = await fixture.mcpClient.callTool({
      name: "synloq_reply",
      arguments: {
        inReplyTo: question.id,
        text: "Answer",
        expectsReply: false,
        idempotencyKey: "mcp-answer-1",
      },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      message: {
        from: "arch",
        to: "cto",
        inReplyTo: question.id,
        threadId: question.threadId,
      },
    });
  });

  it("reads incoming messages from the inbox with the default limit", async () => {
    const { message } = await fixture.cto.send({
      to: "arch",
      text: "Read me",
      expectsReply: false,
      idempotencyKey: "mcp-inbox-1",
    });

    const result = await fixture.mcpClient.callTool({ name: "synloq_inbox", arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ messages: [message] });
  });

  it("treats a wait timeout as a normal empty result", async () => {
    const result = await fixture.mcpClient.callTool({
      name: "synloq_wait",
      arguments: { waitMs: 0 },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ messages: [] });
    expect((result as { content: Array<{ type: string; text: string }> }).content[0]).toMatchObject(
      { type: "text" },
    );
  });

  it("never returns an acknowledged message from synloq_wait without a cursor (#41)", async () => {
    const { message } = await fixture.cto.send({
      to: "arch",
      text: "Read and acknowledged long ago",
      expectsReply: false,
      idempotencyKey: "mcp-wait-unread-1",
    });
    const ack = await fixture.mcpClient.callTool({
      name: "synloq_ack",
      arguments: { messageId: message.id },
    });
    expect(ack.isError).toBeFalsy();

    const waited = await fixture.mcpClient.callTool({
      name: "synloq_wait",
      arguments: { waitMs: 0 },
    });
    expect(waited.isError).toBeFalsy();
    expect(waited.structuredContent).toMatchObject({ messages: [] });

    // synloq_inbox keeps the full history for auditability.
    const history = await fixture.mcpClient.callTool({ name: "synloq_inbox", arguments: {} });
    expect(history.structuredContent).toMatchObject({
      messages: [{ id: message.id, deliveryState: "acked" }],
    });
  });

  it("acknowledges an inbox message without an active delivery adapter", async () => {
    const { message } = await fixture.cto.send({
      to: "arch",
      text: "Read and acknowledge me",
      expectsReply: false,
      idempotencyKey: "mcp-inbox-ack-1",
    });
    const inbox = await fixture.mcpClient.callTool({ name: "synloq_inbox", arguments: {} });
    expect(inbox.structuredContent).toMatchObject({
      messages: [{ id: message.id, deliveryState: "stored" }],
    });

    const result = await fixture.mcpClient.callTool({
      name: "synloq_ack",
      arguments: { messageId: message.id },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      message: { id: message.id, deliveryState: "acked" },
    });
  });

  it("acknowledges a delivered message", async () => {
    const { message } = await fixture.cto.send({
      to: "arch",
      text: "Acknowledge me",
      expectsReply: false,
      idempotencyKey: "mcp-ack-1",
    });
    fixture.messages.setDeliveryState(message.id, "delivered");

    const result = await fixture.mcpClient.callTool({
      name: "synloq_ack",
      arguments: { messageId: message.id },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      message: { id: message.id, deliveryState: "acked" },
    });
  });

  it("maps relay domain errors to tool errors without failing the MCP request", async () => {
    const result = await fixture.mcpClient.callTool({
      name: "synloq_send",
      arguments: {
        to: "missing",
        text: "No recipient",
        expectsReply: false,
        idempotencyKey: "mcp-missing-1",
      },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: "UNKNOWN_RECIPIENT" },
    });
    expect((result as { content: Array<{ type: string; text: string }> }).content[0]).toMatchObject(
      {
        type: "text",
        text: expect.stringContaining("UNKNOWN_RECIPIENT"),
      },
    );
  });

  it.each([
    ["synloq_list", { operator: true }],
    [
      "synloq_send",
      {
        to: "arch",
        text: "Forged",
        expectsReply: false,
        idempotencyKey: "mcp-forged-1",
        from: "cto",
      },
    ],
    [
      "synloq_reply",
      {
        inReplyTo: crypto.randomUUID(),
        text: "Forged",
        expectsReply: false,
        idempotencyKey: "mcp-forged-2",
        to: "cto",
      },
    ],
    ["synloq_inbox", { agentId: "operator" }],
    ["synloq_wait", { waitMs: 0, operator: true }],
    ["synloq_ack", { messageId: crypto.randomUUID(), project: PROJECT }],
  ])("rejects unknown input fields for %s", async (name, args) => {
    const result = await fixture.mcpClient.callTool({ name, arguments: args });

    expect(result.isError).toBe(true);
    expect((result as { content: Array<{ type: string; text: string }> }).content[0]).toMatchObject(
      { type: "text" },
    );
  });

  it("rejects invalid UUIDs and out-of-range inbox limits", async () => {
    const invalidAck = await fixture.mcpClient.callTool({
      name: "synloq_ack",
      arguments: { messageId: "not-a-uuid" },
    });
    const invalidInbox = await fixture.mcpClient.callTool({
      name: "synloq_inbox",
      arguments: { limit: 101 },
    });

    expect(invalidAck.isError).toBe(true);
    expect(invalidInbox.isError).toBe(true);
  });
});
