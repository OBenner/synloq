import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpAdapterRunner } from "../../src/adapters/http-runner.js";
import {
  runKimiWorkAdapter,
  type KimiWorkAdapterConfig,
  type KimiWorkControl,
} from "../../src/adapters/kimi-work.js";
import { serveCommand, type ServeHandle } from "../../src/cli/commands.js";
import { issueTestCredentials } from "../helpers/credentials.js";
import type {
  KimiWorkHistoryEntry,
  KimiWorkSendResult,
} from "../../src/host/kimi-work/control-client.js";
import { RelayHttpClient } from "../../src/transport/http-client.js";

const conversationKey = "agent:main:main:conversation:d7be2b2c-edfc-4fc7-a010-1e7af6465138";
const manifest = `project: synloq
agents:
  cto:
    title: CTO
    role: Coordination
  arch:
    title: Architect
    role: Review
`;

let root: string;
let home: string;
let relay: ServeHandle;
let cto: RelayHttpClient;
let arch: RelayHttpClient;
let config: KimiWorkAdapterConfig;
const closers: Array<() => Promise<void>> = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "synloq-kimi-integration-project-"));
  home = await mkdtemp(join(tmpdir(), "synloq-kimi-integration-home-"));
  vi.stubEnv("SYNLOQ_HOME", home);
  await writeFile(join(root, "synloq.yaml"), manifest);
  const tokens = await issueTestCredentials(root);
  const ctoToken = tokens.get("cto");
  const archToken = tokens.get("arch");
  if (!ctoToken || !archToken) throw new Error("missing test credentials");
  relay = await serveCommand({ projectRoot: root });
  cto = new RelayHttpClient(relay.baseUrl, () => ctoToken);
  arch = new RelayHttpClient(relay.baseUrl, () => archToken);
  config = {
    project: "synloq",
    agentId: "arch",
    workAgentId: "main",
    conversationKey,
    sessionKey: "agent:main:main",
    workspacePath: root,
    kernelSessionId: "conv-integration",
    heartbeatIntervalMs: 5,
    reconciliationDelayMs: 1,
  };
});

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await relay.close();
  await Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(home, { recursive: true, force: true }),
  ]);
  vi.unstubAllEnvs();
});

function fakeControl(): KimiWorkControl & {
  send: ReturnType<typeof vi.fn>;
  messages: ReturnType<typeof vi.fn>;
} {
  return {
    metadata: vi.fn(async () => ({
      conversationKey,
      sessionKey: "agent:main:main",
      kernelSessionId: "conv-integration",
      origin: "client",
      workspacePath: root,
    })),
    busy: vi.fn(async () => false),
    messages: vi.fn(async (): Promise<KimiWorkHistoryEntry[]> => []),
    send: vi.fn(async (): Promise<KimiWorkSendResult> => ({
      accepted: true,
      conversationKey,
      kernelSessionId: "conv-integration",
      turnId: "integration-turn-1",
    })),
  };
}

async function send(key: string) {
  return (
    await cto.send({
      to: "arch",
      text: `[QUESTION]\nIntegration ${key}`,
      expectsReply: true,
      idempotencyKey: key,
    })
  ).message;
}

describe("Kimi Work adapter and real relay", () => {
  it("persists a visible-admission receipt through the existing runner", async () => {
    const control = fakeControl();
    const adapter = await runKimiWorkAdapter(config, arch, { control });
    closers.push(() => adapter.close());
    const runner = new HttpAdapterRunner(arch, adapter, adapter.sessionBinding, 0);
    const message = await send("kimi-integration-delivered-1");

    await expect(runner.runOnce()).resolves.toBe("delivered");
    expect(relay.messages.getMessage(message.id)?.deliveryState).toBe("delivered");
    expect(control.send).toHaveBeenCalledTimes(1);
  });

  it("durably quarantines an uncertain result without a second send", async () => {
    const control = fakeControl();
    control.send.mockRejectedValue(new Error("connection lost after write"));
    const adapter = await runKimiWorkAdapter(config, arch, { control });
    closers.push(() => adapter.close());
    const runner = new HttpAdapterRunner(arch, adapter, adapter.sessionBinding, 0);
    const message = await send("kimi-integration-uncertain-1");

    await expect(runner.runOnce()).resolves.toBe("failed");
    expect(relay.messages.getMessage(message.id)?.deliveryState).toBe("submitted");
    expect(relay.messages.isPaused("synloq", "participant", "arch")).toBe(true);
    await expect(runner.runOnce()).resolves.toBe("empty");
    expect(control.send).toHaveBeenCalledTimes(1);
  });
});
