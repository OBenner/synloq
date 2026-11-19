import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CredentialStore } from "../../src/config/credentials.js";
import type { Participant } from "../../src/domain/message.js";
import { Dispatcher } from "../../src/relay/dispatcher.js";
import { ProtectionPolicy } from "../../src/relay/protection.js";
import { RelayService } from "../../src/relay/relay-service.js";
import { SQLiteMessageStore } from "../../src/storage/message-store.js";
import { SessionStore } from "../../src/storage/session-store.js";
import { RelayHttpServer } from "../../src/transport/http-server.js";
import { proofRequest } from "./proof-helper.js";

const PROJECT = "verdicta";
const participants: Participant[] = [
  { project: PROJECT, agentId: "cto", title: "CTO", role: "Architecture" },
  { project: PROJECT, agentId: "arch", title: "Architect", role: "Review" },
];

interface Fixture {
  baseUrl: string;
  server: RelayHttpServer;
  messages: SQLiteMessageStore;
  sessions: SessionStore;
  ctoToken: string;
  operatorToken: string;
  root: string;
  auditPath: string;
}

let fixture: Fixture;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "synloq-dash-"));
  const credentials = new CredentialStore(root);
  const ctoToken = await credentials.issue(PROJECT, "cto");
  const operatorToken = (await credentials.ensureOperatorCredential(PROJECT)).token;
  const database = join(root, "synloq.sqlite");
  const messages = new SQLiteMessageStore(database);
  const sessions = new SessionStore(database);
  const protection = new ProtectionPolicy(messages);
  const relay = new RelayService(participants, messages, sessions, protection);
  const dispatcher = new Dispatcher(messages, sessions, new Map());
  const auditPath = join(root, "audit.jsonl");
  await writeFile(
    auditPath,
    `${JSON.stringify({
      at: "2026-11-19T10:00:00.000Z",
      project: PROJECT,
      agentId: "cto",
      action: "send",
      decision: "deny",
      reasonCode: "RATE_LIMITED",
      detail: "send request denied",
    })}\n`,
    "utf8",
  );
  const server = new RelayHttpServer({
    project: PROJECT,
    relay,
    credentials,
    sessions,
    dispatcher,
    messages,
    protection,
    auditLogPath: auditPath,
  });
  const baseUrl = await server.listen("127.0.0.1", 0);
  fixture = { baseUrl, server, messages, sessions, ctoToken, operatorToken, root, auditPath };
});

afterEach(async () => {
  await fixture.server.close();
  fixture.sessions.close();
  fixture.messages.close();
  await rm(fixture.root, { recursive: true, force: true });
});

function operatorGet(path: string): Promise<Response> {
  return proofRequest(`${fixture.baseUrl}${path}`, fixture.operatorToken, {
    project: PROJECT,
    agentId: "operator",
  });
}

describe("operator dashboard (#79)", () => {
  it("serves the HTML page only to the operator token", async () => {
    const anonymous = await fetch(`${fixture.baseUrl}/dashboard`);
    expect(anonymous.status).toBe(403);
    // The gate is a human-friendly login form, not a JSON blob.
    expect(anonymous.headers.get("content-type")).toContain("text/html");
    expect(await anonymous.text()).toContain("operator");

    const roleToken = await fetch(`${fixture.baseUrl}/dashboard?token=${fixture.ctoToken}`);
    expect(roleToken.status).toBe(403);
    expect(roleToken.headers.get("content-type")).toContain("text/html");

    const page = await fetch(`${fixture.baseUrl}/dashboard?token=${fixture.operatorToken}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    const html = await page.text();
    expect(html).toContain(PROJECT);
    // Self-contained: no CDN, no external fonts, no external scripts.
    expect(html).not.toMatch(/src="https?:|href="https?:|@import|fonts\./);
  });

  it("rejects mutating methods on the dashboard paths (read-only as a class)", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const pageResponse = await fetch(
        `${fixture.baseUrl}/dashboard?token=${fixture.operatorToken}`,
        { method },
      );
      expect(pageResponse.status).toBe(409); // auth-v2 version gate, never routed
      const apiResponse = await proofRequest(
        `${fixture.baseUrl}/v1/operator/dashboard`,
        fixture.operatorToken,
        { project: PROJECT, agentId: "operator" },
        { method },
      );
      expect([404, 405]).toContain(apiResponse.status);
    }
  });

  it("returns the aggregate state without message bodies by default", async () => {
    fixture.messages.create(
      {
        project: PROJECT,
        from: "cto",
        to: "arch",
        text: "secret body",
        expectsReply: true,
        idempotencyKey: "dash-1",
      },
      crypto.randomUUID(),
      new Date().toISOString(),
      crypto.randomUUID(),
    );

    const response = await operatorGet("/v1/operator/dashboard");
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.project).toBe(PROJECT);
    expect(data.participants).toHaveLength(2);
    expect(data.roles).toEqual(
      expect.arrayContaining([expect.objectContaining({ agentId: "arch", pending: 1 })]),
    );
    expect(data.deliveries).toHaveLength(1);
    expect(data.deliveries[0]).toMatchObject({ from: "cto", to: "arch", deliveryState: "stored" });
    expect(JSON.stringify(data)).not.toContain("secret body");
    expect(data.audit).toHaveLength(1);
    expect(data.audit[0]).toMatchObject({ action: "send", reasonCode: "RATE_LIMITED" });
  });

  it("returns bodies only behind includeText=1 and only to the operator", async () => {
    fixture.messages.create(
      {
        project: PROJECT,
        from: "cto",
        to: "arch",
        text: "secret body",
        expectsReply: false,
        idempotencyKey: "dash-2",
      },
      crypto.randomUUID(),
      new Date().toISOString(),
      crypto.randomUUID(),
    );

    const plain = await operatorGet("/v1/operator/dashboard");
    expect(JSON.stringify(await plain.json())).not.toContain("secret body");

    const withText = await operatorGet("/v1/operator/dashboard?includeText=1");
    const data = await withText.json();
    expect(data.deliveries[0].text).toBe("secret body");

    const asRole = await proofRequest(
      `${fixture.baseUrl}/v1/operator/dashboard?includeText=1`,
      fixture.ctoToken,
      { project: PROJECT, agentId: "cto" },
    );
    expect(asRole.status).toBe(403);
  });

  it("rejects the data endpoint without authentication", async () => {
    const response = await fetch(`${fixture.baseUrl}/v1/operator/dashboard`);
    expect(response.status).toBe(409); // auth-v2 version gate: no proof headers at all
  });
});
