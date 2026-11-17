import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serveCommand, type ServeHandle } from "../../src/cli/commands.js";
import { CredentialStore } from "../../src/config/credentials.js";
import { writeManifest } from "../../src/config/manifest.js";
import { projectPaths } from "../../src/config/paths.js";
import { auditLogPath } from "../../src/relay/audit-log.js";
import { RelayHttpClient } from "../../src/transport/http-client.js";
import {
  challengeSchema,
  hash,
  keyId,
  newNonce,
  requestDigest,
  requestProof,
  responseProof,
  type Challenge,
} from "../../src/transport/auth-proof.js";

const context = { project: "auth-test", agentId: "arch" };
let root: string;
let credentials: CredentialStore;
let token: string;
let relay: ServeHandle;
const closers: Array<() => Promise<void>> = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "synloq-auth-v2-"));
  await writeManifest(root, [
    { ...context, title: "Architect", role: "Review" },
    { ...context, agentId: "cto", title: "CTO", role: "Design" },
  ]);
  credentials = new CredentialStore(root, join(root, "home"));
  token = await credentials.issue(context.project, context.agentId);
  relay = await serveCommand({ projectRoot: root, synloqHome: join(root, "home"), port: 0 });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(closers.splice(0).map((close) => close()));
  await relay?.close();
  if (root) await rm(root, { recursive: true, force: true });
});
async function challenge() {
  const r = await fetch(`${relay.baseUrl}/v1/auth/challenge`, {
    method: "POST",
    body: JSON.stringify({
      authVersion: 2,
      project: context.project,
      kid: keyId(hash(token), context),
      clientNonce: newNonce(),
    }),
  });
  expect(r.status).toBe(200);
  return challengeSchema.parse(await r.json());
}
function signed(c: Challenge, target = "/v1/participants", body = "", method = "GET") {
  const digest = requestDigest(c, method, target, Buffer.from(body));
  return {
    method,
    headers: {
      "x-synloq-auth-version": "2",
      "x-synloq-challenge": c.serverNonce,
      "x-synloq-proof": requestProof(hash(token), c, digest),
    },
    ...(method === "GET" ? {} : { body }),
  };
}
async function listener(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
) {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  closers.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
        server.closeAllConnections();
      }),
  );
  return `http://127.0.0.1:${address.port}`;
}

describe("auth-v2 adversarial conformance", () => {
  it("consumes once atomically before a mutating dispatch, including concurrent replay", async () => {
    const c = await challenge();
    const target = "/v1/messages";
    const body = JSON.stringify({
      to: "cto",
      text: "one mutation",
      expectsReply: false,
      idempotencyKey: crypto.randomUUID(),
    });
    const init = signed(c, target, body, "POST");
    const responses = await Promise.all([
      fetch(relay.baseUrl + target, init),
      fetch(relay.baseUrl + target, init),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 401]);
    expect(relay.messages.listInbox(context.project, "cto", undefined, 100).messages).toHaveLength(
      1,
    );
    const rejected = responses.find((r) => r.status === 401)!;
    expect(await rejected.json()).toMatchObject({ error: { message: "stale_challenge" } });
  });
  it.each(["method", "query", "body"])(
    "rejects tampered %s without consuming a valid challenge",
    async (mode) => {
      const c = await challenge();
      const target = "/v1/inbox?limit=1&waitMs=0";
      const init = signed(c, target, "{}", "POST");
      const tampered =
        mode === "method"
          ? { ...init, method: "PUT" }
          : mode === "body"
            ? { ...init, body: "{ }" }
            : init;
      const r = await fetch(
        relay.baseUrl + (mode === "query" ? "/v1/inbox?waitMs=0&limit=1" : target),
        tampered,
      );
      expect(r.status).toBe(401);
      expect(await r.json()).toMatchObject({ error: { message: "mac_mismatch" } });
      // Correct proof can still be used; authentication succeeds, then unknown POST route fails.
      expect((await fetch(relay.baseUrl + target, init)).status).toBe(404);
    },
  );
  it("rejects expired challenges and allows a fresh exchange", async () => {
    const c = await challenge();
    const init = signed(c);
    const now = vi.spyOn(Date, "now").mockReturnValue(c.expiresAt + 1);
    const expired = await fetch(relay.baseUrl + "/v1/participants", init);
    expect(expired.status).toBe(401);
    expect(await expired.json()).toMatchObject({ error: { message: "stale_challenge" } });
    now.mockRestore();
    await expect(
      new RelayHttpClient(relay.baseUrl, () => token, context).health(),
    ).resolves.toMatchObject({ service: "synloq-relay" });
  });
  it("invalidates outstanding challenges on rotation and re-reads the token provider", async () => {
    const c = await challenge();
    const init = signed(c);
    const client = new RelayHttpClient(relay.baseUrl, () => token, context);
    token = (await credentials.rotate(context.project, context.agentId)).token;
    const r = await fetch(relay.baseUrl + "/v1/participants", init);
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({ error: { message: "unknown_kid" } });
    await expect(client.health()).resolves.toMatchObject({ service: "synloq-relay" });
  });
  it("rejects pre-restart proof and accepts a fresh challenge after restart", async () => {
    const c = await challenge();
    const init = signed(c);
    const port = Number(new URL(relay.baseUrl).port);
    const client = new RelayHttpClient(relay.baseUrl, () => token, context);
    await relay.close();
    relay = await serveCommand({ projectRoot: root, synloqHome: join(root, "home"), port });
    expect((await fetch(relay.baseUrl + "/v1/participants", init)).status).toBe(401);
    await expect(client.health()).resolves.toMatchObject({ service: "synloq-relay" });
  });
  it("fails loudly for an old Bearer client and never accepts mixed auth", async () => {
    const c = await challenge();
    const init = signed(c);
    for (const headers of [
      { authorization: `Bearer ${token}` },
      { ...init.headers, authorization: `Bearer ${token}` },
    ]) {
      const r = await fetch(relay.baseUrl + "/v1/participants", { headers });
      expect(r.status).toBe(409);
      expect(await r.json()).toMatchObject({
        error: { code: "INCOMPATIBLE_PROTOCOL", message: "auth_v2_required; bearer_rejected" },
      });
    }
  });
  it("fails loudly against an old relay without sending its token or business body", async () => {
    const captured: string[] = [];
    const url = await listener(async (req, res) => {
      for await (const chunk of req) captured.push(chunk.toString());
      captured.push(JSON.stringify(req.headers));
      res.writeHead(404);
      res.end("old relay: no auth endpoint");
    });
    const client = new RelayHttpClient(url, () => token, context);
    await expect(
      client.send({
        to: "cto",
        text: "confidential",
        expectsReply: false,
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "INCOMPATIBLE_PROTOCOL" });
    expect(captured.join("")).not.toContain(token);
    expect(captured.join("")).not.toContain("confidential");
  });
  it.each(["project", "role", "proof", "nonce"])(
    "rejects forged challenge %s before the business request",
    async (mode) => {
      let business = 0;
      const url = await listener(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        if (req.url !== "/v1/auth/challenge") {
          business++;
          res.end("{}");
          return;
        }
        const upstream = await fetch(relay.baseUrl + req.url, {
          method: "POST",
          body: Buffer.concat(chunks),
        });
        const c = (await upstream.json()) as Challenge;
        if (mode === "project") c.project = "other";
        if (mode === "role") c.agentId = "operator";
        if (mode === "proof") c.proof = "00".repeat(32);
        if (mode === "nonce") c.clientNonce = newNonce();
        res.end(JSON.stringify(c));
      });
      await expect(
        new RelayHttpClient(url, () => token, context).listParticipants(),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      expect(business).toBe(0);
    },
  );
  it.each(["body", "status", "missing-proof", "forward"])(
    "validates response %s after a genuine challenge",
    async (mode) => {
      const captured: string[] = [];
      const url = await listener(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks);
        captured.push(body.toString(), JSON.stringify(req.headers));
        const headers: Record<string, string> = {};
        for (const k of ["x-synloq-auth-version", "x-synloq-challenge", "x-synloq-proof"]) {
          const v = req.headers[k];
          if (typeof v === "string") headers[k] = v;
        }
        const upstream = await fetch(relay.baseUrl + req.url, {
          method: req.method!,
          headers,
          ...(body.length ? { body } : {}),
        });
        const bytes = Buffer.from(await upstream.arrayBuffer());
        const isChallenge = req.url === "/v1/auth/challenge";
        const proof = upstream.headers.get("x-synloq-proof");
        if (proof && (mode !== "missing-proof" || isChallenge))
          res.setHeader("x-synloq-proof", proof);
        res.statusCode = mode === "status" && !isChallenge ? 500 : upstream.status;
        res.end(mode === "body" && !isChallenge ? Buffer.concat([bytes, Buffer.from(" ")]) : bytes);
      });
      const request = new RelayHttpClient(url, () => token, context).send({
        to: "cto",
        text: "forwarder sees plaintext",
        expectsReply: false,
        idempotencyKey: crypto.randomUUID(),
      });
      if (mode === "forward")
        await expect(request).resolves.toMatchObject({
          message: { text: "forwarder sees plaintext" },
        });
      else
        await expect(request).rejects.toMatchObject({
          code: "UNAUTHORIZED",
          message: "invalid_relay_response_proof",
        });
      expect(captured.join("")).not.toContain(token);
      expect(captured.join("")).toContain("forwarder sees plaintext"); // Explicit confidentiality non-goal.
    },
  );
  it("rejects redirects at both exchange steps", async () => {
    let destinationRequests = 0;
    const destination = await listener((_req, res) => {
      destinationRequests++;
      res.end("{}");
    });
    for (const step of ["challenge", "business"]) {
      const url = await listener(async (req, res) => {
        if (step === "business" && req.url === "/v1/auth/challenge") {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          const upstream = await fetch(relay.baseUrl + req.url, {
            method: "POST",
            body: Buffer.concat(chunks),
          });
          res.end(await upstream.text());
          return;
        }
        res.writeHead(307, { location: destination });
        res.end();
      });
      await expect(
        new RelayHttpClient(url, () => token, context).listParticipants(),
      ).rejects.toThrow();
    }
    expect(destinationRequests).toBe(0);
  });
  it("binds response proof to this request and nonce", async () => {
    const c = await challenge();
    const init = signed(c);
    const r = await fetch(relay.baseUrl + "/v1/participants", init);
    const bytes = Buffer.from(await r.arrayBuffer());
    const digest = requestDigest(c, "GET", "/v1/participants", Buffer.alloc(0));
    expect(r.headers.get("x-synloq-proof")).toBe(responseProof(hash(token), c, digest, 200, bytes));
    expect(
      responseProof(hash(token), { ...c, clientNonce: newNonce() }, digest, 200, bytes),
    ).not.toBe(r.headers.get("x-synloq-proof"));
  });
  it("bounds unauthenticated challenge issuance by rate and outstanding capacity", async () => {
    const start = Date.now();
    let current = start;
    vi.spyOn(Date, "now").mockImplementation(() => current);
    const issue = () =>
      fetch(relay.baseUrl + "/v1/auth/challenge", {
        method: "POST",
        body: JSON.stringify({
          authVersion: 2,
          project: context.project,
          kid: keyId(hash(token), context),
          clientNonce: newNonce(),
        }),
      });
    for (let i = 0; i < 100; i++) expect((await issue()).status).toBe(200);
    const rate = await issue();
    expect(rate.status).toBe(429);
    expect(await rate.json()).toMatchObject({ error: { message: "challenge_rate_limit" } });
    // Advance one issuance window per 100 challenges, remaining inside the TTL.
    for (let i = 100; i < 1024; i++) {
      if (i % 100 === 0) current += 1000;
      expect((await issue()).status).toBe(200);
    }
    const full = await issue();
    expect(full.status).toBe(429);
    expect(await full.json()).toMatchObject({ error: { message: "challenge_capacity" } });
    current = start + 31_000;
    expect((await issue()).status).toBe(200);
  }, 20_000); // 1024 real HTTP + credential-file reads also run under full-suite load.
  it("rejects wrong auth versions and unknown selectors without reflecting secrets", async () => {
    for (const input of [
      {
        authVersion: 1,
        project: context.project,
        kid: keyId(hash(token), context),
        clientNonce: newNonce(),
      },
      { authVersion: 2, project: context.project, kid: "00".repeat(32), clientNonce: newNonce() },
    ]) {
      const r = await fetch(relay.baseUrl + "/v1/auth/challenge", {
        method: "POST",
        body: JSON.stringify(input),
      });
      expect(r.status).toBe(input.authVersion === 1 ? 409 : 401);
      expect(await r.json()).toMatchObject({
        error: { message: input.authVersion === 1 ? "version_mismatch" : "unknown_kid" },
      });
    }
  });
  it("audits malformed challenge input using fixed text without reflecting it", async () => {
    const marker = "untrusted-" + crypto.randomUUID();
    const r = await fetch(relay.baseUrl + "/v1/auth/challenge", {
      method: "POST",
      body: JSON.stringify({
        authVersion: 2,
        project: context.project,
        kid: marker,
        clientNonce: newNonce(),
      }),
    });
    expect(r.status).toBe(400);
    const paths = await projectPaths(root, join(root, "home"));
    const audit = await readFile(auditLogPath(paths.home, paths.key), "utf8");
    expect(audit).toContain("invalid_challenge");
    expect(audit).not.toContain(marker);
    expect(audit).not.toContain(token);
    expect(audit).not.toContain(hash(token));
  });
});
