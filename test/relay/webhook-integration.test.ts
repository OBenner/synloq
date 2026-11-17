import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { doctorCommand, serveCommand } from "../../src/cli/commands.js";
import { RelayService } from "../../src/relay/relay-service.js";
import { ProtectionPolicy } from "../../src/relay/protection.js";
import { SQLiteMessageStore } from "../../src/storage/message-store.js";
import { SessionStore } from "../../src/storage/session-store.js";
import { postWebhook } from "../../src/transport/webhook-http.js";
import type { WebhookEvent } from "../../src/relay/webhook-nudger.js";
import { startWebhook } from "../../src/relay/webhook-lifecycle.js";
import { readWebhookStatus, webhookStatusPath } from "../../src/config/webhook-status.js";
import { projectPaths } from "../../src/config/paths.js";

const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function receiver(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return new URL(`http://127.0.0.1:${address.port}/events`);
}
const event: WebhookEvent = {
  version: 1,
  event: "stored_pending",
  project: "test",
  agentId: "arch",
  messageId: crypto.randomUUID(),
  threadId: crypto.randomUUID(),
  relayInstance: crypto.randomUUID(),
  sentAt: new Date().toISOString(),
};

describe("real webhook transport", () => {
  it("posts identifiers only, carries no relay auth, never follows redirects or retries", async () => {
    let requests = 0;
    const seen: string[] = [];
    let headers: IncomingMessage["headers"] = {};
    const target = await receiver((req, res) => {
      requests++;
      headers = req.headers;
      req.on("data", (chunk) => seen.push(String(chunk)));
      req.on("end", () => {
        res.writeHead(302, { location: "/must-not-follow" });
        res.end("secret response");
      });
    });
    expect(await postWebhook(target, event, new AbortController().signal, 1000)).toBe("HTTP_302");
    expect(requests).toBe(1);
    expect(JSON.parse(seen.join(""))).toEqual(event);
    expect(headers.authorization).toBeUndefined();
    expect(headers.cookie).toBeUndefined();
    expect(headers["x-synloq-token"]).toBeUndefined();
    expect(headers.connection).toBe("close");
  });
  it("uses an absolute timeout and aborts an unresponsive receiver without retry", async () => {
    let requests = 0;
    const target = await receiver(() => {
      requests++;
    });
    expect(await postWebhook(target, event, new AbortController().signal, 50)).toBe("TIMEOUT");
    expect(requests).toBe(1);
    const controller = new AbortController();
    const result = postWebhook(target, event, controller.signal, 1000);
    controller.abort();
    expect(await result).toBe("ABORTED");
  });
});

describe("committed creation boundary", () => {
  it("only observes new committed send/reply, no replay or rejected write; ack-all resets epoch", async () => {
    const messages = new SQLiteMessageStore(":memory:");
    const sessions = new SessionStore(":memory:");
    cleanup.push(
      () => messages.close(),
      () => sessions.close(),
    );
    const created = vi.fn();
    const acknowledged = vi.fn();
    const roster = ["cto", "arch"].map((agentId) => ({
      project: "test",
      agentId,
      title: agentId,
      role: "test",
    }));
    const relay = new RelayService(
      roster,
      messages,
      sessions,
      new ProtectionPolicy(messages),
      undefined,
      undefined,
      undefined,
      { created, acknowledged },
    );
    const cto = { project: "test", agentId: "cto", operator: false };
    const arch = { ...cto, agentId: "arch" };
    const input = { to: "arch", text: "secret body", expectsReply: true, idempotencyKey: "first" };
    created.mockImplementation((msg) => {
      expect(messages.getMessage(msg.id, "test")).toEqual(msg);
    });
    const first = await relay.send(cto, input);
    expect(created).toHaveBeenCalledTimes(1);
    await relay.send(cto, input);
    expect(created).toHaveBeenCalledTimes(1);
    await expect(relay.send(cto, { ...input, text: "conflict" })).rejects.toThrow();
    expect(created).toHaveBeenCalledTimes(1);
    await expect(relay.acknowledge(cto, first.id)).rejects.toThrow();
    expect(acknowledged).not.toHaveBeenCalled();
    await relay.acknowledge(arch, first.id);
    expect(acknowledged).toHaveBeenCalledTimes(1);
    created.mockImplementation(() => {
      throw new Error("observer failure");
    });
    const reply = await relay.reply(arch, {
      inReplyTo: first.id,
      text: "result",
      expectsReply: false,
      idempotencyKey: "reply",
    });
    expect(reply.deliveryState).toBe("stored");
    expect(created).toHaveBeenCalledTimes(2);
    await relay.reply(arch, {
      inReplyTo: first.id,
      text: "result",
      expectsReply: false,
      idempotencyKey: "reply",
    });
    expect(created).toHaveBeenCalledTimes(2);
  });
  it("wires opt-in through serve, resets on last ack and persists bounded diagnostic counters", async () => {
    const root = await mkdtemp(join(tmpdir(), "synloq-webhook-live-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const received: WebhookEvent[] = [];
    const target = await receiver((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        received.push(JSON.parse(body));
        res.end();
      });
    });
    await writeFile(
      join(root, "synloq.yaml"),
      "project: test\nagents: {cto: {title: CTO, role: Send}, arch: {title: Arch, role: Read}}\n",
    );
    await writeFile(
      join(root, "synloq.local.yaml"),
      `webhooks: {enabled: true, url: '${target.href}'}\n`,
    );
    const handle = await serveCommand({ projectRoot: root, synloqHome: join(root, "home") });
    cleanup.push(() => handle.close());
    const { RelayHttpClient } = await import("../../src/transport/http-client.js");
    const { CredentialStore } = await import("../../src/config/credentials.js");
    const credentials = new CredentialStore(root, join(root, "home"));
    const ctoToken = await credentials.issue("test", "cto");
    const archToken = await credentials.issue("test", "arch");
    const cto = new RelayHttpClient(handle.baseUrl, () => ctoToken, {
      project: "test",
      agentId: "cto",
    });
    const arch = new RelayHttpClient(handle.baseUrl, () => archToken, {
      project: "test",
      agentId: "arch",
    });
    const first = await cto.send({
      to: "arch",
      text: "private",
      expectsReply: false,
      idempotencyKey: "one",
    });
    await vi.waitFor(() => expect(received).toHaveLength(1));
    await cto.send({ to: "arch", text: "private", expectsReply: false, idempotencyKey: "one" });
    await arch.acknowledge(first.message.id);
    await new Promise((resolve) => setTimeout(resolve, 1050));
    await cto.send({
      to: "arch",
      text: "another private",
      expectsReply: false,
      idempotencyKey: "two",
    });
    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(received.every((msg) => Object.keys(msg).length === 8)).toBe(true);
    await handle.close();
    const paths = await projectPaths(root, join(root, "home"));
    const snapshot = JSON.parse(
      await readFile(join(paths.home, "state", `${paths.key}.webhook-status.json`), "utf8"),
    );
    expect(snapshot).toMatchObject({ attempted: 2, stopped: true });
    expect(JSON.stringify(snapshot)).not.toContain("private");
    const doctor = await doctorCommand({
      projectRoot: root,
      synloqHome: join(root, "home"),
      skipVersions: true,
    });
    expect(doctor.webhook).toMatchObject({ attempted: 2, stopped: true });
    await writeFile(webhookStatusPath(paths), "x".repeat(5000));
    expect(await readWebhookStatus(paths)).toBeUndefined();
  });
  it("does not reset epoch until delivered-but-unacked messages are acknowledged", async () => {
    const root = await mkdtemp(join(tmpdir(), "synloq-webhook-epoch-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const messages = new SQLiteMessageStore(":memory:");
    cleanup.push(() => messages.close());
    const paths = await projectPaths(root, join(root, "home"));
    let received = 0;
    const target = await receiver((_req, res) => {
      received++;
      res.end();
    });
    const webhook = startWebhook({
      config: { enabled: true, url: target.href },
      project: "test",
      relayPort: 1,
      messages,
      paths,
      audit: { record() {} },
    });
    cleanup.push(() => webhook.close());
    const create = (key: string) =>
      messages.create(
        {
          project: "test",
          from: "cto",
          to: "arch",
          text: "private",
          expectsReply: false,
          idempotencyKey: key,
        },
        crypto.randomUUID(),
        new Date().toISOString(),
        crypto.randomUUID(),
      ).message;
    const first = create("first");
    webhook.observer.created(first);
    await vi.waitFor(() => expect(received).toBe(1));
    messages.setDeliveryState(first.id, "test", "delivered");
    await new Promise((resolve) => setTimeout(resolve, 1050));
    const second = create("second");
    webhook.observer.created(second);
    const ack2 = await messages.acknowledge(second.id, "test", "arch");
    webhook.observer.acknowledged(ack2);
    expect(messages.countUnacknowledged("test", "arch")).toBe(1);
    const third = create("third");
    webhook.observer.created(third);
    await webhook.close();
    expect(received).toBe(1);
  });
  it("disabled local config starts no exporter or snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "synloq-webhook-disabled-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await writeFile(
      join(root, "synloq.yaml"),
      "project: test\nagents: {arch: {title: Arch, role: Read}}\n",
    );
    await writeFile(join(root, "synloq.local.yaml"), "webhooks: {enabled: false}\n");
    const handle = await serveCommand({ projectRoot: root, synloqHome: join(root, "home") });
    await handle.close();
    expect(await readWebhookStatus(await projectPaths(root, join(root, "home")))).toBeUndefined();
  });
});
