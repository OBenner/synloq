import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpAdapterRunner } from "../../src/adapters/http-runner.js";
import { ReferenceAdapter } from "../../src/adapters/reference.js";
import type { DeliveryAdapter, DeliveryReceipt } from "../../src/adapters/types.js";
import { initCommand, serveCommand, type ServeHandle } from "../../src/cli/commands.js";
import { PROTOCOL_VERSION, type AdapterCapabilities } from "../../src/domain/session.js";
import { RelayHttpClient } from "../../src/transport/http-client.js";

const PROJECT = "verdicta";
const SESSION = "review-visible-arch";
const manifest = `project: verdicta
agents:
  cto:
    title: CTO
    role: Architecture
  arch:
    title: Architect
    role: Review
`;
const capabilities: AdapterCapabilities = {
  activeDelivery: true,
  stateReporting: true,
  clientIdempotency: true,
};

interface Binding {
  sessionId: string;
  generation: number;
}

interface Fixture {
  root: string;
  home: string;
  relay: ServeHandle;
  cto: RelayHttpClient;
  arch: RelayHttpClient;
  operator: RelayHttpClient;
}

const fixtures: Fixture[] = [];
const runners: HttpAdapterRunner[] = [];

afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.close();
  for (const fixture of fixtures.splice(0).reverse()) {
    await fixture.relay.close();
    await Promise.all([
      rm(fixture.root, { recursive: true, force: true }),
      rm(fixture.home, { recursive: true, force: true }),
    ]);
  }
  vi.restoreAllMocks();
});

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "synloq-review-generation-project-"));
  const home = await mkdtemp(join(tmpdir(), "synloq-review-generation-home-"));
  vi.stubEnv("SYNLOQ_HOME", home);
  await writeFile(join(root, "synloq.yaml"), manifest);
  const initialized = await initCommand({ projectRoot: root });
  const tokens = new Map(
    initialized.credentials.map((credential) => [credential.agentId, credential.token]),
  );
  const ctoToken = tokens.get("cto");
  const archToken = tokens.get("arch");
  const operatorToken = tokens.get("operator");
  if (!ctoToken || !archToken || !operatorToken) throw new Error("missing review credentials");
  const relay = await serveCommand({ projectRoot: root });
  const current = {
    root,
    home,
    relay,
    cto: new RelayHttpClient(relay.baseUrl, () => ctoToken),
    arch: new RelayHttpClient(relay.baseUrl, () => archToken),
    operator: new RelayHttpClient(relay.baseUrl, () => operatorToken),
  };
  fixtures.push(current);
  return current;
}

async function register(
  client: RelayHttpClient,
  sessionId = SESSION,
  overridden: AdapterCapabilities = capabilities,
): Promise<Binding> {
  const { session } = await client.registerSession({
    sessionId,
    protocolVersion: PROTOCOL_VERSION,
    capabilities: overridden,
  });
  return { sessionId, generation: session.generation };
}

async function idle(client: RelayHttpClient, binding: Binding): Promise<void> {
  await client.heartbeat({ sessionId: binding.sessionId, state: "idle" });
}

function poll(client: RelayHttpClient, binding: Binding, waitMs = 0) {
  return client.nextDelivery({ waitMs, ...binding });
}

function receipt(
  client: RelayHttpClient,
  messageId: string,
  value: DeliveryReceipt,
  binding: Binding,
) {
  return client.receipt(messageId, value, binding);
}

async function send(current: Fixture, key: string) {
  return (
    await current.cto.send({
      to: "arch",
      text: `Delivery ${key}`,
      expectsReply: false,
      idempotencyKey: key,
    })
  ).message;
}

describe("generation-bound HTTP delivery", () => {
  it("rejects an already-running old poll after operator replacement", async () => {
    const current = await fixture();
    const old = await register(current.arch, "session-old");
    await idle(current.arch, old);
    const read = vi.spyOn(
      current.relay.server as unknown as { nextDelivery: (...args: unknown[]) => unknown },
      "nextDelivery",
    );
    const waiting = poll(current.arch, old, 5_000);
    const rejection = expect(waiting).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await vi.waitFor(() => expect(read).toHaveBeenCalled(), { timeout: 1_000, interval: 1 });

    const replacement = await current.operator.replaceSession({
      agentId: "arch",
      sessionId: "session-replacement",
      protocolVersion: PROTOCOL_VERSION,
      capabilities,
    });
    await idle(current.arch, {
      sessionId: "session-replacement",
      generation: replacement.session.generation,
    });
    const message = await send(current, "review-stale-long-poll");

    await rejection;
    expect(replacement.session.generation).not.toBe(old.generation);
    expect(current.relay.messages.getMessage(message.id)?.deliveryState).toBe("stored");
  });

  it("rejects an old-generation delivered receipt after same-session reconnect", async () => {
    const current = await fixture();
    const old = await register(current.arch);
    await idle(current.arch, old);
    const message = await send(current, "review-stale-receipt");
    await poll(current.arch, old);
    await current.arch.registerSession({
      sessionId: SESSION,
      protocolVersion: PROTOCOL_VERSION,
      capabilities,
    });

    await expect(
      receipt(current.arch, message.id, { state: "delivered", clientMessageId: message.id }, old),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(current.relay.messages.getMessage(message.id)?.deliveryState).not.toBe("delivered");
  });

  it("rejects an old-generation failure report after same-session reconnect", async () => {
    const current = await fixture();
    const old = await register(current.arch);
    await idle(current.arch, old);
    const message = await send(current, "review-stale-failure");
    await poll(current.arch, old);
    await current.arch.registerSession({
      sessionId: SESSION,
      protocolVersion: PROTOCOL_VERSION,
      capabilities,
    });
    const beforeFailure = current.relay.messages.getMessage(message.id)?.deliveryState;

    await expect(
      current.arch.deliveryFailure(message.id, {
        ...old,
        code: "RETRYABLE",
        clientIdempotency: true,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(current.relay.messages.getMessage(message.id)?.deliveryState).toBe(beforeFailure);
  });

  it("rejects receipt completion after the claiming session closes", async () => {
    const current = await fixture();
    const binding = await register(current.arch);
    await idle(current.arch, binding);
    const message = await send(current, "review-closed-receipt");
    await poll(current.arch, binding);
    await current.arch.closeSession({ sessionId: binding.sessionId });

    await expect(
      receipt(
        current.arch,
        message.id,
        { state: "delivered", clientMessageId: message.id },
        binding,
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(current.relay.messages.getMessage(message.id)?.deliveryState).toBe("submitted");
  });

  it.each(["busy", "closed"] as const)(
    "rechecks relay readiness before submission when the claim becomes %s",
    async (state) => {
      const current = await fixture();
      const binding = await register(current.arch);
      await idle(current.arch, binding);
      const message = await send(current, `review-claim-${state}`);
      const adapter = new ReferenceAdapter();
      const submit = vi.spyOn(adapter, "submit");
      const gatedRelay = {
        nextDelivery: async (options: { waitMs?: number }) => {
          const result = await poll(current.arch, binding, options.waitMs);
          if (result.message) {
            await current.arch.heartbeat({ sessionId: binding.sessionId, state });
          }
          return result;
        },
        authorizeDelivery: current.arch.authorizeDelivery?.bind(current.arch),
        receipt: current.arch.receipt.bind(current.arch),
        deliveryFailure: current.arch.deliveryFailure.bind(current.arch),
      } as unknown as RelayHttpClient;
      const runner = new HttpAdapterRunner(gatedRelay, adapter, binding, 0);
      runners.push(runner);

      await runner.runOnce().catch(() => undefined);

      expect(submit).not.toHaveBeenCalled();
      expect(adapter.visible(binding.sessionId)).toEqual([]);
      expect(current.relay.messages.getMessage(message.id)?.deliveryState).not.toBe("delivered");
    },
  );

  it("reconciles an outstanding idempotent claim on restart without a duplicate visible entry", async () => {
    const current = await fixture();
    const old = await register(current.arch);
    await idle(current.arch, old);
    const message = await send(current, "review-restart-idempotent");
    await poll(current.arch, old);
    const adapter = new ReferenceAdapter();
    await adapter.submit(SESSION, message);
    expect(adapter.visible(SESSION)).toHaveLength(1);

    const currentBinding = await register(current.arch);
    await idle(current.arch, currentBinding);
    const runner = new HttpAdapterRunner(current.arch, adapter, currentBinding, 0);
    runners.push(runner);
    await runner.runOnce();

    expect(adapter.visible(SESSION).map((entry) => entry.id)).toEqual([message.id]);
    expect(current.relay.messages.getMessage(message.id)?.deliveryState).toBe("delivered");
  });

  it("quarantines an outstanding non-idempotent claim on restart instead of reposting", async () => {
    const current = await fixture();
    const nonIdempotent = { ...capabilities, clientIdempotency: false };
    const old = await register(current.arch, SESSION, nonIdempotent);
    await idle(current.arch, old);
    const message = await send(current, "review-restart-non-idempotent");
    await poll(current.arch, old);

    await register(current.arch, SESSION, nonIdempotent);

    expect(current.relay.messages.getMessage(message.id)?.deliveryState).toBe("submitted");
    expect(current.relay.messages.isPaused(PROJECT, "participant", "arch")).toBe(true);
  });
});

// Keep this compile-time use tied to the production adapter contract.
const adapterContractCheck: DeliveryAdapter = new ReferenceAdapter();
void adapterContractCheck;
