import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { runClaudeAdapter } from "../adapters/claude-channel.js";
import { HttpAdapterRunner } from "../adapters/http-runner.js";
import { runOpenCodeAdapter, type OpenCodeClientSet } from "../adapters/opencode.js";
import { loadAdapterConfiguration } from "../config/adapter.js";
import { SynloqError } from "../domain/errors.js";
import { RelayHttpClient } from "../transport/http-client.js";
import { runClaudeHook, type ClaudeHookIo } from "./claude-hook.js";

export interface StandaloneAdapterDependencies {
  claudeTransport?: Transport;
  openCodeClients?: OpenCodeClientSet;
  deliveryWaitMs?: number;
}

export interface StandaloneAdapterHandle {
  kind: "claude" | "opencode";
  agentId: string;
  sessionId: string;
  close(): Promise<void>;
}

function closeOnce(close: () => Promise<void>): () => Promise<void> {
  let promise: Promise<void> | undefined;
  return () => {
    promise ??= close();
    return promise;
  };
}

export async function startStandaloneAdapter(
  configPath: string,
  dependencies: StandaloneAdapterDependencies = {},
): Promise<StandaloneAdapterHandle> {
  const loaded = await loadAdapterConfiguration(configPath);
  const { configuration } = loaded;
  const relay = new RelayHttpClient(configuration.relayUrl, () => loaded.token);

  if (configuration.kind === "opencode") {
    const adapter = await runOpenCodeAdapter(
      {
        project: configuration.project,
        agentId: configuration.agentId,
        sessionId: configuration.sessionId,
        baseUrl: configuration.baseUrl,
        ...(configuration.heartbeatIntervalMs === undefined
          ? {}
          : { heartbeatIntervalMs: configuration.heartbeatIntervalMs }),
      },
      relay,
      dependencies.openCodeClients,
    );
    const runner = new HttpAdapterRunner(
      relay,
      adapter,
      configuration.sessionId,
      dependencies.deliveryWaitMs,
    );
    runner.start();
    return {
      kind: "opencode",
      agentId: configuration.agentId,
      sessionId: configuration.sessionId,
      close: closeOnce(async () => {
        await runner.close();
        await adapter.close();
      }),
    };
  }

  const running = await runClaudeAdapter(
    {
      sessionId: configuration.sessionId,
      protocolVersion: configuration.protocolVersion,
      ...(configuration.activationVerifiedAt === undefined
        ? {}
        : { activationVerifiedAt: configuration.activationVerifiedAt }),
      ...(configuration.acceptanceMessageId === undefined
        ? {}
        : { acceptanceMessageId: configuration.acceptanceMessageId }),
    },
    dependencies.claudeTransport,
    relay,
  );
  try {
    await running.initialized;
    const { session } = await relay.registerSession({
      sessionId: configuration.sessionId,
      protocolVersion: configuration.protocolVersion,
      capabilities: running.adapter.capabilities,
    });
    if (
      session.project !== configuration.project ||
      session.agentId !== configuration.agentId ||
      session.sessionId !== configuration.sessionId
    ) {
      await relay.closeSession({ sessionId: session.sessionId });
      throw new SynloqError("UNAUTHORIZED", "registered session does not match adapter binding");
    }
    const runner = new HttpAdapterRunner(
      relay,
      running.adapter,
      configuration.sessionId,
      dependencies.deliveryWaitMs,
    );
    runner.start();
    return {
      kind: "claude",
      agentId: configuration.agentId,
      sessionId: configuration.sessionId,
      close: closeOnce(async () => {
        await runner.close();
        await running.server.close();
        await relay.closeSession({ sessionId: configuration.sessionId });
      }),
    };
  } catch (error) {
    await running.server.close();
    throw error;
  }
}

export async function runStandaloneClaudeHook(
  configPath: string,
  io: ClaudeHookIo = {},
): Promise<void> {
  const loaded = await loadAdapterConfiguration(configPath);
  const { configuration } = loaded;
  if (configuration.kind !== "claude") {
    throw new SynloqError("INVALID_INPUT", "Claude hooks require a Claude adapter configuration");
  }
  const relay = new RelayHttpClient(configuration.relayUrl, () => loaded.token);
  await runClaudeHook(
    relay,
    {
      project: configuration.project,
      agentId: configuration.agentId,
      sessionId: configuration.sessionId,
    },
    io,
  );
}
