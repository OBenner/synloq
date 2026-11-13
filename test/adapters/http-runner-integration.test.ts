import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpAdapterRunner } from "../../src/adapters/http-runner.js";
import { ReferenceAdapter } from "../../src/adapters/reference.js";
import type { DeliveryAdapter } from "../../src/adapters/types.js";
import { serveCommand, type ServeHandle } from "../../src/cli/commands.js";
import { issueTestCredentials } from "../helpers/credentials.js";
import { SynloqError } from "../../src/domain/errors.js";
import { PROTOCOL_VERSION, type SessionBinding } from "../../src/domain/session.js";
import { RelayHttpClient } from "../../src/transport/http-client.js";

const PROJECT = "verdicta";
const SESSION = "reference-arch";
const manifest = `project: verdicta
agents:
  cto:
    title: CTO
    role: Architecture
  arch:
    title: Architect
    role: Review
`;

let root: string;
let home: string;
let relay: ServeHandle;
let cto: RelayHttpClient;
let arch: RelayHttpClient;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "synloq-http-runner-project-"));
  home = await mkdtemp(join(tmpdir(), "synloq-http-runner-home-"));
  vi.stubEnv("SYNLOQ_HOME", home);
  await writeFile(join(root, "synloq.yaml"), manifest);
  const tokens = await issueTestCredentials(root);
  const ctoToken = tokens.get("cto");
  const archToken = tokens.get("arch");
  if (!ctoToken || !archToken) throw new Error("missing test credentials");
  relay = await serveCommand({ projectRoot: root });
  cto = new RelayHttpClient(relay.baseUrl, () => ctoToken);
  arch = new RelayHttpClient(relay.baseUrl, () => archToken);
});

afterEach(async () => {
  await relay.close();
  await Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(home, { recursive: true, force: true }),
  ]);
  vi.unstubAllEnvs();
});

async function register(adapter: DeliveryAdapter): Promise<SessionBinding> {
  const { session } = await arch.registerSession({
    sessionId: SESSION,
    protocolVersion: PROTOCOL_VERSION,
    capabilities: adapter.capabilities,
  });
  await arch.heartbeat({ sessionId: SESSION, state: "idle" });
  return { sessionId: session.sessionId, generation: session.generation };
}

async function send(key: string) {
  return (
    await cto.send({
      to: "arch",
      text: `Message ${key}`,
      expectsReply: false,
      idempotencyKey: key,
    })
  ).message;
}

describe("HTTP adapter failure recovery", () => {
  it("resets a retryable submission and preserves FIFO", async () => {
    const adapter = new ReferenceAdapter();
    const binding = await register(adapter);
    const first = await send("http-runner-retry-1");
    const second = await send("http-runner-retry-2");
    const runner = new HttpAdapterRunner(arch, adapter, binding, 0);
    adapter.failNext(first.id);

    await expect(runner.runOnce()).resolves.toBe("failed");
    expect(relay.messages.getMessage(first.id)?.deliveryState).toBe("stored");
    expect(relay.messages.getMessage(second.id)?.deliveryState).toBe("stored");
    await expect(runner.runOnce()).resolves.toBe("delivered");
    await expect(runner.runOnce()).resolves.toBe("delivered");
    expect(adapter.visible(SESSION).map((entry) => entry.id)).toEqual([first.id, second.id]);
  });

  it("releases an uncertain non-idempotent result without pausing the recipient", async () => {
    let fail = true;
    const adapter: DeliveryAdapter = {
      capabilities: {
        activeDelivery: true,
        stateReporting: true,
        clientIdempotency: true,
      },
      state: async () => "idle",
      submit: async (sessionId, message) => {
        adapter.capabilities.clientIdempotency = false;
        if (fail) throw new SynloqError("DELIVERY_UNCERTAIN", "admission outcome is unknown");
        return { state: "delivered", clientMessageId: message.id };
      },
    };
    const binding = await register(adapter);
    const message = await send("http-runner-uncertain-1");
    const runner = new HttpAdapterRunner(arch, adapter, binding, 0);

    await expect(runner.runOnce()).resolves.toBe("failed");
    expect(relay.messages.getMessage(message.id)?.deliveryState).toBe("stored");
    expect(relay.messages.isPaused(PROJECT, "participant", "arch")).toBe(false);
    expect(relay.messages.isPaused(PROJECT, "participant", "cto")).toBe(false);

    fail = false;
    await expect(runner.runOnce()).resolves.toBe("delivered");
    expect(relay.messages.getMessage(message.id)?.deliveryState).toBe("delivered");
  });

  it("rejects a failure report from a different participant", async () => {
    const adapter = new ReferenceAdapter();
    const binding = await register(adapter);
    const message = await send("http-runner-owner-1");
    await arch.nextDelivery({ waitMs: 0, ...binding });

    await expect(
      cto.deliveryFailure(message.id, {
        ...binding,
        code: "RETRYABLE",
        clientIdempotency: true,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(relay.messages.getMessage(message.id)?.deliveryState).toBe("submitted");
  });
});
