import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { runClaudeAdapter } from "../adapters/claude-channel.js";
import { HttpAdapterRunner } from "../adapters/http-runner.js";
import { runOpenCodeAdapter, type OpenCodeApi } from "../adapters/opencode.js";
import { loadAdapterConfiguration } from "../config/adapter.js";
import { loadManifest } from "../config/manifest.js";
import { projectPaths } from "../config/paths.js";
import { formatDiagnostic } from "../diagnostics.js";
import { SynloqError } from "../domain/errors.js";
import { resolveOpenCodeServiceAuth } from "../host/opencode/discovery.js";
import { createStoredPingWatcher } from "../mcp/stored-ping.js";
import { RelayHttpClient } from "../transport/http-client.js";
import { runClaudeHook, type ClaudeHookIo } from "./claude-hook.js";
import { runCodexHook, type CodexHookIo } from "./codex-hook.js";

export interface StandaloneAdapterDependencies {
  claudeTransport?: Transport;
  openCodeApi?: OpenCodeApi;
  deliveryWaitMs?: number;
  environment?: NodeJS.ProcessEnv;
}

export interface StandaloneAdapterHandle {
  kind: "claude" | "opencode";
  agentId: string;
  sessionId: string;
  readonly closed: Promise<void>;
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
    const authToken =
      configuration.servicePassword ??
      (await resolveOpenCodeServiceAuth({
        environment: dependencies.environment ?? process.env,
      }));
    const adapter = await runOpenCodeAdapter(
      {
        project: configuration.project,
        agentId: configuration.agentId,
        sessionId: configuration.sessionId,
        baseUrl: configuration.baseUrl,
        ...(authToken !== undefined ? { authToken } : {}),
        ...(configuration.heartbeatIntervalMs === undefined
          ? {}
          : { heartbeatIntervalMs: configuration.heartbeatIntervalMs }),
      },
      relay,
      dependencies.openCodeApi,
    );
    const runner = new HttpAdapterRunner(
      relay,
      adapter,
      adapter.sessionBinding,
      dependencies.deliveryWaitMs,
    );
    runner.start();
    // Issue #45: stored-ping watcher for the OpenCode adapter process —
    // nudge the visible session via the host prompt API when incoming mail
    // sits stored past the threshold while the session is live and idle.
    let storedPingTimer: ReturnType<typeof setInterval> | undefined;
    if (configuration.storedPing !== false) {
      const participants = await loadManifest(configuration.projectRoot);
      const paths = await projectPaths(configuration.projectRoot, configuration.synloqHome);
      const watcher = createStoredPingWatcher({
        project: configuration.project,
        agentId: configuration.agentId,
        participants,
        databasePath: paths.database,
        diagnostics: process.stderr,
        push: (text) => adapter.ping(text),
      });
      storedPingTimer = setInterval(() => void watcher.check(), 60_000);
      storedPingTimer.unref?.();
    }
    let markClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      markClosed = resolve;
    });
    return {
      kind: "opencode",
      agentId: configuration.agentId,
      sessionId: configuration.sessionId,
      closed,
      close: closeOnce(async () => {
        if (storedPingTimer) clearInterval(storedPingTimer);
        try {
          await runner.close();
          await adapter.close();
        } finally {
          markClosed();
        }
      }),
    };
  }

  if (configuration.kind === "codex") {
    throw new SynloqError(
      "INVALID_INPUT",
      "Codex active delivery is unsupported; use codex-hook and MCP inbox",
    );
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
      surface: "claude",
      ...(configuration.acceptanceMessageId === undefined
        ? {}
        : { acceptanceMessageId: configuration.acceptanceMessageId }),
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
      { sessionId: session.sessionId, generation: session.generation },
      dependencies.deliveryWaitMs,
    );
    runner.start();
    let markClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      markClosed = resolve;
    });
    const close = closeOnce(async () => {
      try {
        await runner.close();
        await running.server.close();
        await relay.closeSession({ sessionId: configuration.sessionId });
      } finally {
        markClosed();
      }
    });
    running.server.onclose = () => {
      void close().catch(() => undefined);
    };
    return {
      kind: "claude",
      agentId: configuration.agentId,
      sessionId: configuration.sessionId,
      closed,
      close,
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

export async function runStandaloneCodexHook(
  configPath: string,
  io: CodexHookIo = {},
): Promise<void> {
  const loaded = await loadAdapterConfiguration(configPath);
  const { configuration } = loaded;
  if (configuration.kind !== "codex") {
    throw new SynloqError("INVALID_INPUT", "Codex hooks require a Codex adapter configuration");
  }
  const relay = new RelayHttpClient(configuration.relayUrl, () => loaded.token);
  await runCodexHook(relay, configuration, io);
}
