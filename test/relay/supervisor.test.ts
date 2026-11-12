import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serveCommand, type ServeHandle } from "../../src/cli/commands.js";
import { CredentialStore } from "../../src/config/credentials.js";
import { writeManifest } from "../../src/config/manifest.js";
import type { Participant } from "../../src/domain/message.js";
import { ensureRelay } from "../../src/relay/supervisor.js";

const roots: string[] = [];
const relays: ServeHandle[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(relays.splice(0).map((relay) => relay.close()));
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(project = "example"): Promise<{
  root: string;
  home: string;
  token: string;
  participants: Participant[];
}> {
  const root = await mkdtemp(join(tmpdir(), "synloq-supervisor-project-"));
  const home = await mkdtemp(join(tmpdir(), "synloq-supervisor-home-"));
  roots.push(root, home);
  const participants: Participant[] = [
    { project, agentId: "reviewer", title: "Reviewer", role: "Review evidence" },
  ];
  await writeManifest(root, participants);
  const credential = await new CredentialStore(root, home).ensureCredential(project, "reviewer");
  return { root, home, token: credential.token, participants };
}

async function unusedUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test port");
  const url = `http://127.0.0.1:${address.port}`;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return url;
}

describe("ensureRelay", () => {
  it("reuses a compatible authenticated relay without owning or closing it", async () => {
    const { root, home, token, participants } = await fixture();
    const existing = await serveCommand({ projectRoot: root, synloqHome: home, port: 0 });
    relays.push(existing);

    const reused = await ensureRelay({
      projectRoot: root,
      project: "example",
      relayUrl: existing.baseUrl,
      token,
      synloqHome: home,
    });

    expect(reused.owned).toBe(false);
    expect(reused.baseUrl).toBe(existing.baseUrl);
    await expect(reused.client.listParticipants()).resolves.toEqual({ participants });
    await reused.close();
    await expect(existing.server).toBe(existing.server);
    await expect(reused.client.listParticipants()).resolves.toEqual({ participants });
  });

  it("owns exactly one new relay on a refused loopback endpoint", async () => {
    const { root, home, token, participants } = await fixture();
    const relayUrl = await unusedUrl();

    const owned = await ensureRelay({
      projectRoot: root,
      project: "example",
      relayUrl,
      token,
      synloqHome: home,
    });
    expect(owned.owned).toBe(true);
    expect(owned.baseUrl).toBe(relayUrl);
    await expect(owned.client.listParticipants()).resolves.toEqual({ participants });
    await owned.close();
    await expect(owned.client.listParticipants()).rejects.toThrow();
  });

  it("fails closed on an unrelated HTTP service and leaves it running", async () => {
    const { root, home, token } = await fixture();
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end("{}");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test port");

    await expect(
      ensureRelay({
        projectRoot: root,
        project: "example",
        relayUrl: `http://127.0.0.1:${address.port}`,
        token,
        synloqHome: home,
      }),
    ).rejects.toMatchObject({ code: "STORAGE_FAILURE" });
    expect(server.listening).toBe(true);
  });

  it("never sends the credential to a listener without the health marker", async () => {
    const { root, home, token } = await fixture();
    const requests: { path: string | undefined; authorization: string | undefined }[] = [];
    const server = createServer((request, response) => {
      requests.push({ path: request.url, authorization: request.headers.authorization });
      response.setHeader("content-type", "application/json");
      response.end("{}");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test port");

    await expect(
      ensureRelay({
        projectRoot: root,
        project: "example",
        relayUrl: `http://127.0.0.1:${address.port}`,
        token,
        synloqHome: home,
      }),
    ).rejects.toMatchObject({ code: "STORAGE_FAILURE" });

    expect(requests).toEqual([{ path: "/v1/health", authorization: undefined }]);
  });

  it("sends the credential only after the health marker matches", async () => {
    const { root, home, token } = await fixture();
    const requests: { path: string | undefined; authorization: string | undefined }[] = [];
    const server = createServer((request, response) => {
      requests.push({ path: request.url, authorization: request.headers.authorization });
      response.setHeader("content-type", "application/json");
      if (request.url === "/v1/health") {
        response.end(JSON.stringify({ service: "synloq-relay", protocolVersion: 1 }));
        return;
      }
      response.statusCode = 401;
      response.end(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "no credential" } }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test port");

    await expect(
      ensureRelay({
        projectRoot: root,
        project: "example",
        relayUrl: `http://127.0.0.1:${address.port}`,
        token,
        synloqHome: home,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    expect(requests).toEqual([
      { path: "/v1/health", authorization: undefined },
      { path: "/v1/participants", authorization: `Bearer ${token}` },
    ]);
  });

  it("rejects the wrong project and wrong credential without starting another relay", async () => {
    const first = await fixture("other");
    const existing = await serveCommand({
      projectRoot: first.root,
      synloqHome: first.home,
      port: 0,
    });
    relays.push(existing);

    await expect(
      ensureRelay({
        projectRoot: first.root,
        project: "example",
        relayUrl: existing.baseUrl,
        token: first.token,
        synloqHome: first.home,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      ensureRelay({
        projectRoot: first.root,
        project: "other",
        relayUrl: existing.baseUrl,
        token: "wrong-token",
        synloqHome: first.home,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rechecks EADDRINUSE and reuses a compatible winner", async () => {
    const { root, home, token, participants } = await fixture();
    const relayUrl = await unusedUrl();
    let probes = 0;
    const serve = vi.fn(async () => {
      throw Object.assign(new Error("occupied"), { code: "EADDRINUSE" });
    });

    const result = await ensureRelay({
      projectRoot: root,
      project: "example",
      relayUrl,
      token,
      synloqHome: home,
      serve: serve as never,
      probe: async () => {
        probes += 1;
        if (probes === 1) throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
        return participants;
      },
    });

    expect(result.owned).toBe(false);
    expect(serve).toHaveBeenCalledTimes(1);
    expect(probes).toBe(2);
  });

  it("never listens after an ambiguous probe and rejects non-loopback URLs", async () => {
    const { root, home, token } = await fixture();
    const serve = vi.fn();
    await expect(
      ensureRelay({
        projectRoot: root,
        project: "example",
        relayUrl: "http://127.0.0.1:4100",
        token,
        synloqHome: home,
        serve: serve as never,
        probe: async () => {
          throw new Error("ambiguous private response");
        },
      }),
    ).rejects.toThrow("Synloq relay endpoint is unavailable or incompatible");
    expect(serve).not.toHaveBeenCalled();

    await expect(
      ensureRelay({
        projectRoot: root,
        project: "example",
        relayUrl: "http://example.com:4100",
        token,
        synloqHome: home,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
