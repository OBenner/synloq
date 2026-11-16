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

describe("automatic relay lifecycle", { timeout: 20_000, retry: 1 }, () => {
  it("preserves the conversation and re-elects one owner without a standalone server", async () => {
    const root = await mkdtemp(join(tmpdir(), "synloq-e2e-project-"));
    const home = await mkdtemp(join(tmpdir(), "synloq-e2e-home-"));
    roots.push(root, home);
    const participants: Participant[] = [
      { project: "example", agentId: "product", title: "Product", role: "Own scope" },
      { project: "example", agentId: "reviewer", title: "Reviewer", role: "Review evidence" },
    ];
    await writeManifest(root, participants);
    const credentials = new CredentialStore(root, home);
    const product = await credentials.ensureCredential("example", "product");
    const reviewer = await credentials.ensureCredential("example", "reviewer");
    const relayUrl = await unusedUrl();
    const common = {
      projectRoot: root,
      project: "example",
      relayUrl,
      synloqHome: home,
      retryDelayMs: 5,
      monitorIntervalMs: 10,
      maxReconnectAttempts: 30,
      // Real loopback probes compete with the full suite on CI/Windows —
      // 100 ms expired under load (issue #13).
      probeTimeoutMs: 1_000,
    };
    const events: string[] = [];
    const first = await startRelaySupervisor({ ...common, token: product.token });
    const second = await startRelaySupervisor({
      ...common,
      token: reviewer.token,
      onOwnerLost: () => {
        events.push("host-invalidated");
      },
      onRecovered: () => {
        events.push("host-restarted");
      },
    });
    supervisors.push(first, second);
    expect(first.owned).toBe(true);
    expect(second.owned).toBe(false);

    const sent = await first.client.send({
      to: "reviewer",
      text: "QUESTION: Is the automatic relay ready?",
      expectsReply: true,
      idempotencyKey: "relay-lifecycle-e2e-question-1",
    });
    await first.close();

    // Election under parallel-suite load: the default 5 s was observed to
    // expire at 7994 ms in CI (run 43907126160, issue #13).
    await vi.waitFor(() => expect(second.owned).toBe(true), { timeout: 10_000 });
    expect(events).toEqual(["host-invalidated", "host-restarted"]);
    const inbox = await second.client.inbox({ limit: 10 });
    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0]).toMatchObject({
      id: sent.message.id,
      threadId: sent.message.threadId,
      text: "QUESTION: Is the automatic relay ready?",
    });
    await expect(second.client.acknowledge(sent.message.id)).resolves.toMatchObject({
      message: { id: sent.message.id, deliveryState: "acked" },
    });
    const reply = await second.client.reply({
      inReplyTo: sent.message.id,
      text: "RESULT: Relay recovered with the original thread.",
      expectsReply: false,
      idempotencyKey: "relay-lifecycle-e2e-result-1",
    });
    expect(reply.message.threadId).toBe(sent.message.threadId);
    await expect(first.client.inbox({ limit: 10 })).resolves.toMatchObject({
      messages: [{ id: reply.message.id, threadId: sent.message.threadId }],
    });
    await expect(second.client.listParticipants()).resolves.toEqual({ participants });
  });
});
