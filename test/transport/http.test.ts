import { proofRequest } from "./proof-helper.js";
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
import type { SecurityEvent } from "../../src/relay/audit-log.js";
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
  audit: SecurityEvent[];
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
  const protection = new ProtectionPolicy(messages);
  const audit: SecurityEvent[] = [];
  const auditLog = {
    record: (event: SecurityEvent) => {
      audit.push(event);
    },
  };
  const relay = new RelayService(
    participants,
    messages,
    sessions,
    protection,
    undefined,
    undefined,
    auditLog,
  );
  const dispatcher = new Dispatcher(messages, sessions, new Map());
  const server = new RelayHttpServer({
    project: PROJECT,
    relay,
    credentials,
    sessions,
    dispatcher,
    messages,
    protection,
    audit: auditLog,
  });
  const baseUrl = await server.listen("127.0.0.1", 0);
  fixture = {
    baseUrl,
    server,
    messages,
    sessions,
    cto: new RelayHttpClient(baseUrl, () => ctoToken, { project: PROJECT, agentId: "cto" }),
    arch: new RelayHttpClient(baseUrl, () => archToken, { project: PROJECT, agentId: "arch" }),
    operator: new RelayHttpClient(baseUrl, () => operatorToken, {
      project: PROJECT,
      agentId: "operator",
    }),
    ctoToken,
    archToken,
    operatorToken,
    root,
    home,
    audit,
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

describe("binding denial audit (#96)", () => {
  it("rechecks a parked delivery poll after operator replacement and denies once", async () => {
    const binding = await registerArch();
    fixture.audit.length = 0;
    const claim = vi.spyOn(fixture.messages, "claimNextDelivery");
    const pending = fixture.arch.nextDelivery({ ...binding, waitMs: 5000 }).then(
      (value) => ({ value, error: undefined }),
      (error) => ({ value: undefined, error }),
    );
    await vi.waitFor(() => expect(claim).toHaveBeenCalledTimes(1));
    await fixture.operator.replaceSession({
      agentId: "arch",
      sessionId: "arch-replacement",
      protocolVersion: PROTOCOL_VERSION,
      capabilities,
    });
    const result = await pending;
    expect(result.error).toMatchObject({ code: "UNAUTHORIZED" });
    expect(claim).toHaveBeenCalledTimes(2);
    const denied = fixture.audit.filter((event) => event.decision === "deny");
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ action: "claim", reasonCode: "UNAUTHORIZED" });
    expect(fixture.sessions.list(PROJECT)[0]?.sessionId).toBe("arch-replacement");
    expect(
      await fixture.arch.nextDelivery({ ...binding, generation: 2, sessionId: "arch-replacement" }),
    ).toMatchObject({ message: null });
  });

  it.each(["missing", "stale"] as const)(
    "rejects %s delivery generation without claiming",
    async (mode) => {
      const { message, binding } = await setup();
      const query = new URLSearchParams({ sessionId: binding.sessionId });
      if (mode === "stale") query.set("generation", String(binding.generation + 1));
      const response = await authenticated(
        `${fixture.baseUrl}/v1/deliveries/next?${query}`,
        fixture.archToken,
        {},
      );
      const code = mode === "missing" ? "INVALID_INPUT" : "UNAUTHORIZED";
      expect(response.status).toBe(mode === "missing" ? 400 : 403);
      expect(await response.json()).toMatchObject({ error: { code } });
      expect(fixture.messages.getMessage(message.id, PROJECT)).toEqual(message);
      expect(fixture.audit).toHaveLength(1);
      expect(fixture.audit[0]).toMatchObject({ action: "claim", reasonCode: code });
    },
  );

  it("preserves own binding, mirror reads, and one audit per foreign ack/reply", async () => {
    const { message, binding } = await setup();
    const mirror = await fixture.arch.inbox();
    expect(mirror.messages).toContainEqual(message);
    await expect(fixture.arch.acknowledge(message.id)).rejects.toMatchObject({
      code: "NOT_WRITER",
    });
    await expect(fixture.cto.acknowledge(message.id, "session-cto-a")).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(
      fixture.cto.reply({
        inReplyTo: message.id,
        sessionId: "session-cto-a",
        text: "foreign reply",
        expectsReply: false,
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fixture.audit.map((event) => [event.action, event.reasonCode])).toEqual([
      ["acknowledge", "NOT_WRITER"],
      ["acknowledge", "UNAUTHORIZED"],
      ["reply", "NOT_FOUND"],
    ]);
    expect(fixture.messages.getMessage(message.id, PROJECT)).toEqual(message);
    const claimed = await fixture.arch.nextDelivery(binding);
    expect(claimed.message?.id).toBe(message.id);
    await fixture.arch.authorizeDelivery(message.id, binding);
    await fixture.arch.receipt(message.id, { state: "submitted" }, binding);
    await fixture.arch.acknowledge(message.id, binding.sessionId);
    expect(fixture.audit).toHaveLength(3);
  });

  it("audits a foreign recipient receipt once and preserves the claim", async () => {
    const { message, binding } = await setup();
    await fixture.arch.nextDelivery(binding);
    const before = fixture.messages.getMessage(message.id, PROJECT);
    await expect(
      fixture.cto.receipt(
        message.id,
        { state: "submitted" },
        {
          sessionId: "session-cto-a",
          generation: 1,
        },
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(fixture.messages.getMessage(message.id, PROJECT)).toEqual(before);
    expect(fixture.audit).toHaveLength(1);
    expect(fixture.audit[0]).toMatchObject({ agentId: "cto", action: "deliveryReceipt" });
  });

  it("keeps whitelisted surface diagnostics but drops attempted binding from deny", async () => {
    await setup();
    await expect(
      fixture.arch.registerSession({
        sessionId: "unknown-conversation",
        surface: "opencode-mcp",
        ownership: "exclusive",
        protocolVersion: PROTOCOL_VERSION,
        capabilities,
      }),
    ).rejects.toMatchObject({ code: "DUPLICATE_SESSION" });
    expect(fixture.audit).toHaveLength(1);
    expect(fixture.audit[0]?.detail).toBe(
      "registerSession request denied (surface 'opencode-mcp')",
    );
  });

  it("does not audit a valid session-less channel as a caller-chat violation", async () => {
    const { message } = await fixture.cto.send({
      to: "arch",
      text: "token-only",
      expectsReply: false,
      idempotencyKey: crypto.randomUUID(),
    });
    expect((await fixture.arch.inbox()).messages).toContainEqual(message);
    await fixture.arch.acknowledge(message.id);
    expect(fixture.audit).toEqual([]);
  });

  async function setup() {
    const { message } = await fixture.cto.send({
      to: "arch",
      text: "private-body-marker",
      expectsReply: false,
      idempotencyKey: crypto.randomUUID(),
    });
    const binding = await registerArch();
    await fixture.cto.registerSession({
      sessionId: "session-cto-a",
      protocolVersion: PROTOCOL_VERSION,
      capabilities,
    });
    const beforeSessions = fixture.sessions.list(PROJECT);
    fixture.audit.length = 0;
    return { message, binding, beforeSessions };
  }

  it.each([
    ["heartbeat", "POST", "/v1/sessions/heartbeat"],
    ["close", "POST", "/v1/sessions/close"],
    ["claim", "GET", "/v1/deliveries/next"],
    ["authorizeDelivery", "POST", "/v1/deliveries/ID/authorize"],
    ["deliveryReceipt", "POST", "/v1/deliveries/ID/receipt"],
    ["deliveryFailure", "POST", "/v1/deliveries/ID/failure"],
  ])("audits %s foreign binding once without mutation", async (action, method, route) => {
    const { message, binding, beforeSessions } = await setup();
    const path = route.replace("ID", message.id);
    const foreign = { sessionId: "session-cto-a", generation: binding.generation };
    const response =
      method === "GET"
        ? await authenticated(
            `${fixture.baseUrl}${path}?${new URLSearchParams({
              sessionId: foreign.sessionId,
              generation: String(foreign.generation),
            })}`,
            fixture.archToken,
          )
        : await post(
            path,
            fixture.archToken,
            JSON.stringify({
              ...foreign,
              ...(action === "heartbeat" ? { state: "idle" } : {}),
              ...(action === "deliveryReceipt" ? { state: "submitted" } : {}),
              ...(action === "deliveryFailure"
                ? { code: "RETRYABLE", clientIdempotency: true }
                : {}),
            }),
          );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });
    expect(fixture.messages.getMessage(message.id, PROJECT)).toEqual(message);
    expect(fixture.sessions.list(PROJECT)).toEqual(beforeSessions);
    expect(fixture.audit).toHaveLength(1);
    expect(fixture.audit[0]).toMatchObject({
      project: PROJECT,
      agentId: "arch",
      action,
      decision: "deny",
      reasonCode: "UNAUTHORIZED",
    });
    expect(JSON.stringify(fixture.audit)).not.toContain("session-cto-a");
    expect(JSON.stringify(fixture.audit)).not.toContain(fixture.archToken);
    expect(JSON.stringify(fixture.audit)).not.toContain(message.text);
  });

  it("audits operator doctor rejection without revealing sessions", async () => {
    await setup();
    const response = await authenticated(
      `${fixture.baseUrl}/v1/operator/doctor`,
      fixture.archToken,
      {},
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: "UNAUTHORIZED", message: "operator credential required" },
    });
    expect(fixture.audit).toHaveLength(1);
    expect(fixture.audit[0]).toMatchObject({ action: "doctor", reasonCode: "UNAUTHORIZED" });
    expect(await fixture.operator.doctor()).toHaveProperty("sessions");
    expect(fixture.audit).toHaveLength(1);
  });

  it("keeps one bounded event for writer and registration denials", async () => {
    await setup();
    const marker = "unverified-secret-marker";
    await expect(
      fixture.arch.send({
        to: "cto",
        text: marker,
        sessionId: marker,
        expectsReply: false,
        idempotencyKey: marker,
      }),
    ).rejects.toMatchObject({ code: "NOT_WRITER" });
    expect(fixture.audit).toHaveLength(1);
    expect(fixture.audit[0]).toMatchObject({ action: "send", reasonCode: "NOT_WRITER" });
    expect(JSON.stringify(fixture.audit)).not.toContain(marker);
    fixture.audit.length = 0;
    await expect(
      fixture.arch.registerSession({
        sessionId: marker,
        surface: marker,
        protocolVersion: PROTOCOL_VERSION,
        capabilities,
      }),
    ).rejects.toMatchObject({ code: "DUPLICATE_SESSION" });
    expect(fixture.audit).toHaveLength(1);
    expect(fixture.audit[0]).toMatchObject({
      action: "registerSession",
      reasonCode: "DUPLICATE_SESSION",
    });
    expect(JSON.stringify(fixture.audit)).not.toContain(marker);
  });
});

function authenticated(url: string, token: string, init: RequestInit = {}): Promise<Response> {
  const agentId =
    token === fixture.archToken ? "arch" : token === fixture.operatorToken ? "operator" : "cto";
  return proofRequest(url, token, { project: PROJECT, agentId }, init);
}

async function post(path: string, token: string, body: string): Promise<Response> {
  return authenticated(`${fixture.baseUrl}${path}`, token, {
    method: "POST",
    headers: { "content-type": "application/json" },
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
  it("atomically admits only one competing exclusive registration", async () => {
    const input = {
      sessionId: "session-arch-a",
      protocolVersion: PROTOCOL_VERSION,
      capabilities,
      ownership: "exclusive" as const,
    };
    const outcomes = await Promise.allSettled([
      fixture.arch.registerSession(input),
      fixture.arch.registerSession(input),
    ]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: "DUPLICATE_SESSION" }) }),
    ]);
    expect(archBinding().generation).toBe(1);
  });

  it("manual registration takes priority and stale close cannot close its new generation", async () => {
    const input = { sessionId: "session-arch-a", protocolVersion: PROTOCOL_VERSION, capabilities };
    const { session: child } = await fixture.arch.registerSession({
      ...input,
      ownership: "exclusive",
    });
    const { session: manual } = await fixture.arch.registerSession(input);
    await expect(
      fixture.arch.closeSession({ sessionId: child.sessionId, generation: child.generation }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      fixture.arch.heartbeat({
        sessionId: child.sessionId,
        generation: child.generation,
        state: "idle",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      fixture.arch.registerSession({ ...input, ownership: "exclusive" }),
    ).rejects.toMatchObject({ code: "DUPLICATE_SESSION" });
    expect(archBinding().generation).toBe(manual.generation);
    await fixture.arch.closeSession({ sessionId: manual.sessionId, generation: manual.generation });
  });

  it("serves an unauthenticated health marker before any credential check", async () => {
    const anonymous = await fetch(`${fixture.baseUrl}/v1/health`);
    expect(anonymous.status).toBe(200);
    await expect(anonymous.json()).resolves.toEqual({
      service: "synloq-relay",
      protocolVersion: PROTOCOL_VERSION,
      authVersion: 2,
    });

    await expect(fixture.cto.health()).resolves.toEqual({
      service: "synloq-relay",
      protocolVersion: PROTOCOL_VERSION,
    });
  });

  it("requires authentication and derives identity from the token", async () => {
    await expect(fetch(`${fixture.baseUrl}/v1/participants`)).resolves.toMatchObject({
      status: 409,
    });
    await expect(
      authenticated(`${fixture.baseUrl}/v1/participants`, "wrong-token", {}),
    ).resolves.toMatchObject({ status: 401 });

    const response = await authenticated(
      `${fixture.baseUrl}/v1/participants`,
      fixture.ctoToken,
      {},
    );

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
    expect(fixture.messages.getMessage(result.message.id, result.message.project)).toEqual(
      result.message,
    );
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
    fixture.messages.setDeliveryState(message.id, message.project, "delivered");

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

  it("filters acked messages from the unread inbox only (#41)", async () => {
    const { message: acked } = await fixture.cto.send({
      to: "arch",
      text: "Already read",
      expectsReply: false,
      idempotencyKey: "http-unread-acked-1",
    });
    fixture.messages.setDeliveryState(acked.id, acked.project, "delivered");
    await fixture.arch.acknowledge(acked.id);

    const { message: fresh } = await fixture.cto.send({
      to: "arch",
      text: "Still unread",
      expectsReply: false,
      idempotencyKey: "http-unread-fresh-1",
    });

    // Default inbox keeps full history for auditability.
    const full = await fixture.arch.inbox({ limit: 50, waitMs: 0 });
    expect(full.messages.map((message) => message.id)).toEqual([acked.id, fresh.id]);

    // unread=1 (the synloq_wait path) never returns the acked message.
    const unread = await fixture.arch.inbox({ limit: 50, waitMs: 0, unread: true });
    expect(unread.messages.map((message) => message.id)).toEqual([fresh.id]);
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

  it("rejects a heartbeat carrying a stale generation after re-registration", async () => {
    const first = await fixture.arch.registerSession({
      sessionId: "session-arch-a",
      protocolVersion: PROTOCOL_VERSION,
      capabilities,
    });
    await fixture.arch.registerSession({
      sessionId: "session-arch-a",
      protocolVersion: PROTOCOL_VERSION,
      capabilities,
    });

    await expect(
      fixture.arch.heartbeat({
        sessionId: "session-arch-a",
        state: "busy",
        generation: first.session.generation,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
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
    expect(fixture.messages.getMessage(message.id, message.project)?.deliveryState).toBe(
      "submitted",
    );
    await expect(nextArch()).resolves.toEqual({ message: null, ...binding });

    const receipt: DeliveryReceipt = {
      state: "delivered",
      clientMessageId: message.id,
    };
    await expect(receiptArch(message.id, receipt)).resolves.toEqual({
      message: { ...message, deliveryState: "delivered" },
    });
  });

  it("reports the remaining backlog as pendingAfter on a claim", async () => {
    const binding = await registerArch();
    const { message: first } = await fixture.cto.send({
      to: "arch",
      text: "First queued delivery",
      expectsReply: false,
      idempotencyKey: "http-delivery-backlog-1",
    });
    const { message: second } = await fixture.cto.send({
      to: "arch",
      text: "Second queued delivery",
      expectsReply: false,
      idempotencyKey: "http-delivery-backlog-2",
    });

    await expect(nextArch()).resolves.toEqual({ message: first, ...binding, pendingAfter: 1 });
    // The FIFO blocker releases only after the earlier claim is delivered.
    await receiptArch(first.id, { state: "delivered", clientMessageId: first.id });
    await expect(nextArch()).resolves.toEqual({ message: second, ...binding });
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
    const aborted = authenticated(
      `${fixture.baseUrl}/v1/deliveries/next?${query}`,
      fixture.archToken,
      {
        signal: controller.signal,
      },
    );
    const rejection = expect(aborted).rejects.toThrow();
    observing = true;
    await read;

    // Make work available without an event, then wake the old waiter only by closing it.
    fixture.messages.resume(PROJECT, gate.scope, gate.scopeId);
    controller.abort();
    await rejection;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(fixture.messages.getMessage(message.id, message.project)?.deliveryState).toBe("stored");
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
    const invalidLimit = await authenticated(
      `${fixture.baseUrl}/v1/inbox?limit=101&waitMs=0`,
      fixture.archToken,
      {},
    );
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
  it("rejects non-loopback base URLs before any request is made", () => {
    for (const baseUrl of [
      "http://example.com:4100",
      "https://127.0.0.1:4100",
      "http://user@127.0.0.1:4100",
      "http://127.0.0.1:4100/path",
      "http://localhost:4100",
    ]) {
      expect(
        () => new RelayHttpClient(baseUrl, () => "token", { project: PROJECT, agentId: "arch" }),
      ).toThrowError(
        expect.objectContaining({
          name: "SynloqError",
          code: "INVALID_INPUT",
        }),
      );
    }
    expect(
      () =>
        new RelayHttpClient("http://127.0.0.1:4100", () => "token", {
          project: PROJECT,
          agentId: "arch",
        }),
    ).not.toThrow();
    expect(
      () =>
        new RelayHttpClient("http://[::1]:4100/", () => "token", {
          project: PROJECT,
          agentId: "arch",
        }),
    ).not.toThrow();
  });

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

describe("RelayHttpServer long-poll concurrency cap (security M2)", () => {
  const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

  async function wakeArch(key: string) {
    await fixture.cto.send({
      to: "arch",
      text: "Wake the waiters",
      expectsReply: false,
      idempotencyKey: key,
    });
  }

  it("rejects a third concurrent inbox long poll with RATE_LIMITED and frees slots on resolve", async () => {
    const first = fixture.arch.inbox({ limit: 1, waitMs: 25_000 });
    const second = fixture.arch.inbox({ limit: 1, waitMs: 25_000 });
    await settle();

    await expect(fixture.arch.inbox({ limit: 1, waitMs: 25_000 })).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });

    // A wake resolves both waiters; their slots are free for the next poll.
    await wakeArch("m2-wake-inbox-1");
    await Promise.all([first, second]);
    await expect(fixture.arch.inbox({ limit: 1, waitMs: 5 })).resolves.toBeDefined();
  });

  it("audits a rejected inbox long poll with the route that hit the cap", async () => {
    const first = fixture.arch.inbox({ limit: 1, waitMs: 25_000 });
    const second = fixture.arch.inbox({ limit: 1, waitMs: 25_000 });
    await settle();

    await expect(fixture.arch.inbox({ limit: 1, waitMs: 25_000 })).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });

    const rejections = fixture.audit.filter((event) => event.action === "longPoll");
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toMatchObject({
      project: PROJECT,
      agentId: "arch",
      decision: "deny",
      reasonCode: "RATE_LIMITED",
    });
    expect(rejections[0]?.detail).toContain("GET /v1/inbox");

    await wakeArch("m2-wake-inbox-audit");
    await Promise.all([first, second]);
  });

  it("audits delivery-route rejections and stays silent for instant polls", async () => {
    await registerArch();
    const first = nextArch(500);
    const second = nextArch(500);
    await settle();

    await expect(nextArch(500)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    const rejections = fixture.audit.filter((event) => event.action === "longPoll");
    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.detail).toContain("GET /v1/deliveries/next");

    // Instant polls never touch the cap or the audit log.
    await expect(fixture.arch.inbox({ limit: 1, waitMs: 0 })).resolves.toBeDefined();
    expect(fixture.audit.filter((event) => event.action === "longPoll")).toHaveLength(1);

    await Promise.all([first, second]);
  });

  it("releases the slot when a long-poll connection aborts", async () => {
    const controller = new AbortController();
    const aborted = authenticated(`${fixture.baseUrl}/v1/inbox?waitMs=25000`, fixture.archToken, {
      signal: controller.signal,
    });
    const pending = fixture.arch.inbox({ limit: 1, waitMs: 25_000 });
    await settle();

    controller.abort();
    await expect(aborted).rejects.toThrow();
    await settle(100); // let the server observe the connection close

    // One slot is still held by `pending`; the aborted one must be free.
    await expect(fixture.arch.inbox({ limit: 1, waitMs: 5 })).resolves.toBeDefined();

    await wakeArch("m2-wake-inbox-2");
    await pending;
  });

  it("does not occupy a slot for instant polls (waitMs = 0)", async () => {
    const first = fixture.arch.inbox({ limit: 1, waitMs: 25_000 });
    const second = fixture.arch.inbox({ limit: 1, waitMs: 25_000 });
    await settle();

    await expect(fixture.arch.inbox({ limit: 1, waitMs: 0 })).resolves.toBeDefined();
    await expect(fixture.arch.inbox({ limit: 50, waitMs: 0, unread: true })).resolves.toBeDefined();

    await wakeArch("m2-wake-inbox-3");
    await Promise.all([first, second]);
  });

  it("caps delivery long polls per identity as well", async () => {
    await registerArch();
    const first = nextArch(500);
    const second = nextArch(500);
    await settle();

    await expect(nextArch(500)).rejects.toMatchObject({ code: "RATE_LIMITED" });

    // Delivery claims are exclusive, so message wakes cannot fan out here;
    // let both waiters time out normally — their slots must be free again.
    await Promise.all([first, second]);
    await expect(nextArch(500)).resolves.toMatchObject({ message: null });
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
    expect(fixture.messages.getMessage(message.id, message.project)?.deliveryState).toBe("stored");
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
    expect(fixture.messages.getMessage(message.id, message.project)?.deliveryState).toBe(
      "submitted",
    );
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
    expect(fixture.messages.getMessage(message.id, message.project)?.deliveryState).toBe(
      "submitted",
    );
  });
});

describe("RelayHttpServer single-writer enforcement (#46)", () => {
  async function registerCto(sessionId: string) {
    await fixture.cto.registerSession({
      sessionId,
      protocolVersion: PROTOCOL_VERSION,
      capabilities,
    });
  }

  function draft(sessionId?: string) {
    return {
      to: "arch",
      text: "writer check",
      expectsReply: false,
      idempotencyKey: `http-${crypto.randomUUID()}`,
      ...(sessionId === undefined ? {} : { sessionId }),
    };
  }

  it("rejects non-writer writes with 403 NOT_WRITER and accepts the writer", async () => {
    await registerCto("session-cto-writer");

    await expect(fixture.cto.send(draft())).rejects.toMatchObject({ code: "NOT_WRITER" });
    await expect(fixture.cto.send(draft("session-cto-mirror"))).rejects.toMatchObject({
      code: "NOT_WRITER",
    });
    const mirror = await post("/v1/messages", fixture.ctoToken, JSON.stringify(draft()));
    expect(mirror.status).toBe(403);

    await expect(fixture.cto.send(draft("session-cto-writer"))).resolves.toMatchObject({
      message: expect.objectContaining({ from: "cto" }),
    });
    // The mirror keeps its reads.
    const inbox = await fixture.cto.inbox();
    expect(inbox.messages.length).toBeGreaterThanOrEqual(0);
  });
});
