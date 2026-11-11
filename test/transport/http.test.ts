import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeliveryReceipt } from "../../src/adapters/types.js";
import { CredentialStore } from "../../src/config/credentials.js";
import type { Participant } from "../../src/domain/message.js";
import { PROTOCOL_VERSION, type SessionBinding } from "../../src/domain/session.js";
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
const capabilities = {
  activeDelivery: true,
  stateReporting: true,
  clientIdempotency: true,
};

interface Fixture {
  baseUrl: string;
  server: RelayHttpServer;
  messages: SQLiteMessageStore;
  sessions: SessionStore;
  cto: RelayHttpClient;
  arch: RelayHttpClient;
  operator: RelayHttpClient;
  ctoToken: string;
  archToken: string;
  operatorToken: string;
  root: string;
  home: string;
}

let fixture: Fixture;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "synloq-http-project-"));
  const home = await mkdtemp(join(tmpdir(), "synloq-http-home-"));
  vi.stubEnv("SYNLOQ_HOME", home);
  const credentials = new CredentialStore(root);
  const ctoToken = await credentials.issue(PROJECT, "cto");
  const archToken = await credentials.issue(PROJECT, "arch");
  const operatorToken = await credentials.issue(PROJECT, "operator");
  const database = join(root, "synloq.sqlite");
  const messages = new SQLiteMessageStore(database);
  const sessions = new SessionStore(database);
  const relay = new RelayService(participants, messages, sessions, new ProtectionPolicy(messages));
  const dispatcher = new Dispatcher(messages, sessions, new Map());
  const server = new RelayHttpServer({
    project: PROJECT,
    relay,
    credentials,
    sessions,
    dispatcher,
    messages,
  });
  const baseUrl = await server.listen("127.0.0.1", 0);
  fixture = {
    baseUrl,
    server,
    messages,
    sessions,
    cto: new RelayHttpClient(baseUrl, () => ctoToken),
    arch: new RelayHttpClient(baseUrl, () => archToken),
    operator: new RelayHttpClient(baseUrl, () => operatorToken),
    ctoToken,
    archToken,
    operatorToken,
    root,
    home,
  };
});

afterEach(async () => {
  await fixture.server.close();
  fixture.sessions.close();
  fixture.messages.close();
  await Promise.all([
    rm(fixture.root, { recursive: true, force: true }),
    rm(fixture.home, { recursive: true, force: true }),
  ]);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function authorized(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function post(path: string, token: string, body: string): Promise<Response> {
  return fetch(`${fixture.baseUrl}${path}`, {
    method: "POST",
    headers: { ...authorized(token), "content-type": "application/json" },
    body,
  });
}

function archBinding(sessionId = "session-arch-a"): SessionBinding {
  const session = fixture.sessions
    .list(PROJECT)
    .find((candidate) => candidate.agentId === "arch" && candidate.sessionId === sessionId);
  if (!session) throw new Error("arch session is not registered");
  return { sessionId, generation: session.generation };
}

async function registerArch(sessionId = "session-arch-a"): Promise<SessionBinding> {
  const { session } = await fixture.arch.registerSession({
    sessionId,
    protocolVersion: PROTOCOL_VERSION,
    capabilities,
  });
  await fixture.arch.heartbeat({ sessionId, state: "idle" });
  return { sessionId, generation: session.generation };
}

function nextArch(waitMs = 0) {
  return fixture.arch.nextDelivery({ waitMs, ...archBinding() });
}

function receiptArch(messageId: string, receipt: DeliveryReceipt) {
  return fixture.arch.receipt(messageId, receipt, archBinding());
}

describe("RelayHttpServer authentication and participant routes", () => {
  it("requires authentication and derives identity from the token", async () => {
    await expect(fetch(`${fixture.baseUrl}/v1/participants`)).resolves.toMatchObject({
      status: 401,
    });
    await expect(
      fetch(`${fixture.baseUrl}/v1/participants`, {
        headers: authorized("wrong-token"),
      }),
    ).resolves.toMatchObject({ status: 401 });

    const response = await fetch(`${fixture.baseUrl}/v1/participants`, {
      headers: authorized(fixture.ctoToken),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      participants: participants.map((participant) => expect.objectContaining(participant)),
    });
  });

  it("sends with project and sender derived from the credential", async () => {
    const result = await fixture.cto.send({
      to: "arch",
      text: "Review the HTTP boundary",
      expectsReply: true,
      idempotencyKey: "http-send-1",
    });

    expect(result.message).toMatchObject({
      project: PROJECT,
      from: "cto",
      to: "arch",
      deliveryState: "stored",
    });
    expect(fixture.messages.getMessage(result.message.id)).toEqual(result.message);
  });

  it("replies in the authorized thread", async () => {
    const { message: question } = await fixture.cto.send({
      to: "arch",
      text: "Question",
      expectsReply: true,
      idempotencyKey: "http-question-1",
    });

    const { message: answer } = await fixture.arch.reply({
      inReplyTo: question.id,
      text: "Answer",
      expectsReply: false,
      idempotencyKey: "http-answer-1",
    });

    expect(answer).toMatchObject({
      from: "arch",
      to: "cto",
      inReplyTo: question.id,
      threadId: question.threadId,
    });
  });

  it("acknowledges only as the recipient", async () => {
    const { message } = await fixture.cto.send({
      to: "arch",
      text: "Acknowledge this",
      expectsReply: false,
      idempotencyKey: "http-ack-1",
    });
    fixture.messages.setDeliveryState(message.id, "delivered");

    await expect(fixture.arch.acknowledge(message.id)).resolves.toEqual({
      message: { ...message, deliveryState: "acked" },
    });
    await expect(fixture.cto.acknowledge(message.id)).rejects.toMatchObject({
      name: "SynloqError",
      code: "UNAUTHORIZED",
    });
  });

  it("supports a long-poll timeout as a normal empty result", async () => {
    const response = await fixture.arch.inbox({ limit: 50, waitMs: 5 });

    expect(response).toEqual({ messages: [], nextCursor: undefined });
  });

  it("wakes an inbox long poll when a message is accepted", async () => {
    const waiting = fixture.arch.inbox({ limit: 1, waitMs: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const { message } = await fixture.cto.send({
      to: "arch",
      text: "Wake the inbox",
      expectsReply: false,
      idempotencyKey: "http-wake-inbox-1",
    });

    await expect(waiting).resolves.toEqual({
      messages: [message],
      nextCursor: undefined,
    });
  });
});

describe("RelayHttpServer sessions and active delivery", () => {
  it("registers, heartbeats, and closes the authenticated session", async () => {
    const registered = await fixture.arch.registerSession({
      sessionId: "session-arch-a",
      protocolVersion: PROTOCOL_VERSION,
      capabilities,
    });
    expect(registered.session).toMatchObject({
      project: PROJECT,
      agentId: "arch",
      sessionId: "session-arch-a",
      state: "unknown",
    });

    const heartbeat = await fixture.arch.heartbeat({
      sessionId: "session-arch-a",
      state: "busy",
    });
    expect(heartbeat.session.state).toBe("busy");

    const closed = await fixture.arch.closeSession({
      sessionId: "session-arch-a",
    });
    expect(closed.session.state).toBe("closed");
    expect(fixture.sessions.list(PROJECT)[0]?.state).toBe("closed");
  });

  it("pulls one FIFO delivery and records its receipt", async () => {
    const binding = await registerArch();
    const { message } = await fixture.cto.send({
      to: "arch",
      text: "Pull this delivery",
      expectsReply: false,
      idempotencyKey: "http-delivery-1",
    });

    await expect(nextArch()).resolves.toEqual({ message, ...binding });
    expect(fixture.messages.getMessage(message.id)?.deliveryState).toBe("submitted");
    await expect(nextArch()).resolves.toEqual({ message: null, ...binding });

    const receipt: DeliveryReceipt = {
      state: "delivered",
      clientMessageId: message.id,
    };
    await expect(receiptArch(message.id, receipt)).resolves.toEqual({
      message: { ...message, deliveryState: "delivered" },
    });
  });

  it("returns an empty delivery after a normal long-poll timeout", async () => {
    const binding = await registerArch();

    await expect(nextArch(5)).resolves.toEqual({ message: null, ...binding });
  });

  it("wakes a delivery long poll after an idle heartbeat", async () => {
    const binding = await registerArch();
    await fixture.arch.heartbeat({
      sessionId: "session-arch-a",
      state: "busy",
    });
    const { message } = await fixture.cto.send({
      to: "arch",
      text: "Wait until idle",
      expectsReply: false,
      idempotencyKey: "http-delivery-wake-1",
    });
    const waiting = nextArch(5_000);
    await new Promise((resolve) => setTimeout(resolve, 20));

    await fixture.arch.heartbeat({
      sessionId: "session-arch-a",
      state: "idle",
    });

    await expect(waiting).resolves.toEqual({ message, ...binding });
  });

  it("keeps a delivery stored when its waiting adapter aborts", async () => {
    const binding = await registerArch();
    const gate = { scope: "participant" as const, scopeId: "arch" };
    await fixture.operator.pause(gate);
    const { message } = await fixture.cto.send({
      to: "arch",
      text: "Do not strand this delivery",
      expectsReply: false,
      idempotencyKey: "http-delivery-abort-1",
    });

    let markRead!: () => void;
    const read = new Promise<void>((resolve) => {
      markRead = resolve;
    });
    const originalIsPaused = fixture.messages.isPaused.bind(fixture.messages);
    let observing = false;
    vi.spyOn(fixture.messages, "isPaused").mockImplementation((project, scope, scopeId) => {
      const paused = originalIsPaused(project, scope, scopeId);
      if (observing && scope === "participant" && scopeId === "arch") {
        observing = false;
        markRead();
      }
      return paused;
    });
    const controller = new AbortController();
    const query = new URLSearchParams({
      ...binding,
      generation: String(binding.generation),
      waitMs: "5000",
    });
    const aborted = fetch(`${fixture.baseUrl}/v1/deliveries/next?${query}`, {
      headers: authorized(fixture.archToken),
      signal: controller.signal,
    });
    const rejection = expect(aborted).rejects.toThrow();
    observing = true;
    await read;

    // Make work available without an event, then wake the old waiter only by closing it.
    fixture.messages.resume(PROJECT, gate.scope, gate.scopeId);
    controller.abort();
    await rejection;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(fixture.messages.getMessage(message.id)?.deliveryState).toBe("stored");
    await expect(nextArch()).resolves.toEqual({ message, ...binding });
  });

  it("does not expose replacement to an ordinary agent", async () => {
    await fixture.arch.registerSession({
      sessionId: "session-arch-a",
      protocolVersion: PROTOCOL_VERSION,
      capabilities,
    });
    const replacement = {
      agentId: "arch",
      sessionId: "session-arch-b",
      protocolVersion: PROTOCOL_VERSION,
      capabilities,
    };

    await expect(fixture.arch.replaceSession(replacement)).rejects.toMatchObject({
      name: "SynloqError",
      code: "UNAUTHORIZED",
    });
    await expect(fixture.operator.replaceSession(replacement)).resolves.toMatchObject({
      session: { sessionId: "session-arch-b" },
    });
  });
});

describe("RelayHttpServer operator routes and errors", () => {
  it("allows only an operator to pause and resume delivery", async () => {
    const gate = { scope: "participant" as const, scopeId: "arch" };

    await expect(fixture.cto.pause(gate)).rejects.toMatchObject({
      name: "SynloqError",
      code: "UNAUTHORIZED",
    });
    await expect(fixture.operator.pause(gate)).resolves.toEqual({ ok: true });
    expect(fixture.messages.isPaused(PROJECT, gate.scope, gate.scopeId)).toBe(true);

    await expect(fixture.cto.resume(gate)).rejects.toMatchObject({
      name: "SynloqError",
      code: "UNAUTHORIZED",
    });
    await expect(fixture.operator.resume(gate)).resolves.toEqual({ ok: true });
    expect(fixture.messages.isPaused(PROJECT, gate.scope, gate.scopeId)).toBe(false);
  });

  it("exposes raw session diagnostics only to an operator", async () => {
    await fixture.arch.registerSession({
      sessionId: "session-arch-a",
      protocolVersion: PROTOCOL_VERSION,
      capabilities,
    });

    await expect(fixture.cto.doctor()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(fixture.operator.doctor()).resolves.toEqual({
      sessions: [
        expect.objectContaining({
          agentId: "arch",
          sessionId: "session-arch-a",
        }),
      ],
    });
  });

  it("rejects malformed JSON without changing storage", async () => {
    const response = await post("/v1/messages", fixture.ctoToken, "{");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_INPUT" },
    });
    expect(fixture.messages.listInbox(PROJECT, "arch", undefined, 50).messages).toEqual([]);
  });

  it("rejects a JSON body over 64 KiB", async () => {
    const body = JSON.stringify({
      to: "arch",
      text: "x".repeat(64 * 1024),
      expectsReply: false,
      idempotencyKey: "http-too-large-1",
    });
    const response = await post("/v1/messages", fixture.ctoToken, body);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_INPUT" },
    });
    expect(fixture.messages.listInbox(PROJECT, "arch", undefined, 50).messages).toEqual([]);
  });

  it("validates query parameters and strict route bodies", async () => {
    const invalidLimit = await fetch(`${fixture.baseUrl}/v1/inbox?limit=101&waitMs=0`, {
      headers: authorized(fixture.archToken),
    });
    expect(invalidLimit.status).toBe(400);

    const forgedIdentity = await post(
      "/v1/messages",
      fixture.ctoToken,
      JSON.stringify({
        project: "another-project",
        from: "arch",
        to: "arch",
        text: "Forged",
        expectsReply: false,
        idempotencyKey: "http-forged-1",
      }),
    );
    expect(forgedIdentity.status).toBe(400);
  });

  it("preserves SynloqError codes through the typed client", async () => {
    const request = fixture.cto.send({
      to: "missing",
      text: "No recipient",
      expectsReply: false,
      idempotencyKey: "http-missing-1",
    });

    await expect(request).rejects.toMatchObject({
      name: "SynloqError",
      code: "UNKNOWN_RECIPIENT",
    });
  });

  it("maps duplicate sessions to a conflict", async () => {
    const registration = {
      sessionId: "session-arch-a",
      protocolVersion: PROTOCOL_VERSION,
      capabilities,
    };
    await fixture.arch.registerSession(registration);

    const response = await post(
      "/v1/sessions/register",
      fixture.archToken,
      JSON.stringify({ ...registration, sessionId: "session-arch-b" }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "DUPLICATE_SESSION" },
    });
  });

  it("maps storage failures to an internal error", async () => {
    fixture.messages.close();

    const response = await post(
      "/v1/messages",
      fixture.ctoToken,
      JSON.stringify({
        to: "arch",
        text: "Storage is closed",
        expectsReply: false,
        idempotencyKey: "http-storage-1",
      }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "STORAGE_FAILURE" },
    });
  });

  it("rejects non-loopback listen addresses", () => {
    expect(() => fixture.server.listen("0.0.0.0", 0)).toThrow(/loopback/);
    expect(() => fixture.server.listen("localhost", 0)).toThrow(/loopback/);
  });
});

describe("RelayHttpClient resource behavior", () => {
  it("uses the required timeouts only for long polls", async () => {
    await registerArch();
    const timeout = vi.spyOn(AbortSignal, "timeout");

    await fixture.cto.listParticipants();
    await fixture.arch.inbox({ limit: 1, waitMs: 9 });
    await nextArch(11);

    expect(timeout).toHaveBeenNthCalledWith(1, 5_000);
    expect(timeout).toHaveBeenNthCalledWith(2, 5_009);
    expect(timeout).toHaveBeenNthCalledWith(3, 5_011);
  });

  it("releases a pending long poll when the server closes", async () => {
    const waiting = fixture.arch.inbox({ limit: 1, waitMs: 25_000 });
    await new Promise((resolve) => setTimeout(resolve, 20));

    await fixture.server.close();

    await expect(waiting).resolves.toEqual({
      messages: [],
      nextCursor: undefined,
    });
  });
});

describe("Claude delivery receipt evidence", () => {
  async function createMessage(submitted: boolean) {
    const binding = await registerArch();
    const { message } = await fixture.cto.send({
      to: "arch",
      text: "Correlate this receipt",
      expectsReply: false,
      idempotencyKey: `http-evidence-${submitted ? "submitted" : "stored"}`,
    });
    if (submitted) await nextArch();
    return { message, binding };
  }

  function evidenceFor(
    message: { id: string; threadId: string },
    binding = archBinding(),
    sessionId = binding.sessionId,
  ) {
    return {
      sessionId,
      generation: binding.generation,
      project: PROJECT,
      from: "cto",
      messageId: message.id,
      threadId: message.threadId,
    };
  }

  it("accepts exact evidence for a submitted message and bound session", async () => {
    const { message, binding } = await createMessage(true);

    await expect(
      fixture.arch.receipt(
        message.id,
        {
          state: "delivered",
          clientMessageId: message.id,
          evidence: evidenceFor(message, binding),
        },
        binding,
      ),
    ).resolves.toMatchObject({
      message: { id: message.id, deliveryState: "delivered" },
    });
  });

  it("rejects evidence for a stored, unsubmitted UUID", async () => {
    const { message, binding } = await createMessage(false);

    await expect(
      fixture.arch.receipt(
        message.id,
        {
          state: "delivered",
          clientMessageId: message.id,
          evidence: evidenceFor(message, binding),
        },
        binding,
      ),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "delivery evidence requires a submitted message",
    });
    expect(fixture.messages.getMessage(message.id)?.deliveryState).toBe("stored");
  });

  it.each([
    [{ project: "other-project" }],
    [{ from: "arch" }],
    [{ messageId: "f99b3f6d-e1a4-4d5f-9634-ee33c33efce8" }],
    [{ threadId: "other-thread" }],
  ])("rejects mismatched provenance %j", async (override) => {
    const { message, binding } = await createMessage(true);
    const evidence = { ...evidenceFor(message, binding), ...override };

    await expect(
      fixture.arch.receipt(
        message.id,
        { state: "delivered", clientMessageId: message.id, evidence },
        binding,
      ),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "delivery evidence provenance does not match the submitted claim",
    });
    expect(fixture.messages.getMessage(message.id)?.deliveryState).toBe("submitted");
  });

  it("rejects evidence for a different bound session", async () => {
    const { message, binding } = await createMessage(true);

    await expect(
      fixture.arch.receipt(
        message.id,
        {
          state: "delivered",
          clientMessageId: message.id,
          evidence: evidenceFor(message, binding, "another-session"),
        },
        binding,
      ),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "delivery evidence provenance does not match the submitted claim",
    });
    expect(fixture.messages.getMessage(message.id)?.deliveryState).toBe("submitted");
  });
});
