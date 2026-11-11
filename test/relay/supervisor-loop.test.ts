import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialStore } from "../../src/config/credentials.js";
import { writeManifest } from "../../src/config/manifest.js";
import type { Participant } from "../../src/domain/message.js";
import { startRelaySupervisor, type RelaySupervisorLoop } from "../../src/relay/supervisor-loop.js";

const roots: string[] = [];
const supervisors: RelaySupervisorLoop[] = [];

afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{
  root: string;
  home: string;
  token: string;
  participants: Participant[];
}> {
  const root = await mkdtemp(join(tmpdir(), "synloq-loop-project-"));
  const home = await mkdtemp(join(tmpdir(), "synloq-loop-home-"));
  roots.push(root, home);
  const participants: Participant[] = [
    { project: "example", agentId: "reviewer", title: "Reviewer", role: "Review evidence" },
    { project: "example", agentId: "product", title: "Product", role: "Own scope" },
  ];
  await writeManifest(root, participants);
  const credential = await new CredentialStore(root, home).ensureCredential("example", "reviewer");
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

describe("startRelaySupervisor", () => {
  it("elects a survivor after owner shutdown and preserves durable messages", async () => {
    const { root, home, token, participants } = await fixture();
    const relayUrl = await unusedUrl();
    const ownerLost = vi.fn();
    const options = {
      projectRoot: root,
      project: "example",
      relayUrl,
      token,
      synloqHome: home,
      retryDelayMs: 5,
      monitorIntervalMs: 10,
      maxReconnectAttempts: 30,
      probeTimeoutMs: 100,
    };
    const first = await startRelaySupervisor(options);
    const second = await startRelaySupervisor({ ...options, onOwnerLost: ownerLost });
    supervisors.push(first, second);
    expect(first.owned).toBe(true);
    expect(second.owned).toBe(false);

    const sent = await first.client.send({
      to: "reviewer",
      text: "durable across failover",
      expectsReply: false,
      idempotencyKey: "supervisor-failover-1",
    });
    await first.close();

    await vi.waitFor(() => expect(second.owned).toBe(true), { timeout: 5_000 });
    expect(ownerLost).toHaveBeenCalledTimes(1);
    await expect(second.client.listParticipants()).resolves.toEqual({ participants });
    await expect(second.client.inbox({ limit: 10 })).resolves.toMatchObject({
      messages: [{ id: sent.message.id, text: "durable across failover" }],
    });
    expect(first.owned).toBe(false);
  });

  it("allows exactly one owner during simultaneous startup", async () => {
    const { root, home, token } = await fixture();
    const relayUrl = await unusedUrl();
    const options = {
      projectRoot: root,
      project: "example",
      relayUrl,
      token,
      synloqHome: home,
      retryDelayMs: 5,
      monitorIntervalMs: 20,
      probeTimeoutMs: 100,
    };

    const [first, second] = await Promise.all([
      startRelaySupervisor(options),
      startRelaySupervisor(options),
    ]);
    supervisors.push(first, second);

    expect([first.owned, second.owned].filter(Boolean)).toHaveLength(1);
    await expect(first.client.listParticipants()).resolves.toBeDefined();
    await expect(second.client.listParticipants()).resolves.toBeDefined();
  });

  it("makes close idempotent and stops further election", async () => {
    const { root, home, token } = await fixture();
    const relayUrl = await unusedUrl();
    const supervisor = await startRelaySupervisor({
      projectRoot: root,
      project: "example",
      relayUrl,
      token,
      synloqHome: home,
      retryDelayMs: 5,
      monitorIntervalMs: 5,
    });
    supervisors.push(supervisor);

    await Promise.all([supervisor.close(), supervisor.close()]);
    expect(supervisor.owned).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await expect(supervisor.client.listParticipants(50)).rejects.toThrow();
  });
});
