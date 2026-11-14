import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { runKimiWorkAdapter, type KimiWorkAdapter } from "../adapters/kimi-work.js";
import { HttpAdapterRunner, OutstandingTracker } from "../adapters/http-runner.js";
import { loadManifest } from "../config/manifest.js";
import { projectPaths } from "../config/paths.js";
import { formatDiagnostic } from "../diagnostics.js";
import { SynloqError } from "../domain/errors.js";
import { languageSchema, type Language } from "../i18n/index.js";
import {
  kimiWorkConfigurationSchema,
  resolveKimiWorkBinding,
  type ResolvedKimiWorkBinding,
} from "../host/kimi-work/binding.js";
import {
  openCodeConfigurationSchema,
  resolveOpenCodeBinding,
  type ResolvedOpenCodeBinding,
} from "../host/opencode/binding.js";
import { startRelaySupervisor, type RelaySupervisorLoop } from "../relay/supervisor-loop.js";
import { RelayHttpClient } from "../transport/http-client.js";
import { isLoopbackHttpUrl } from "../transport/loopback.js";
import { registerSynloqTools } from "./tools.js";
import { createWatchdogDiagnostic } from "./watchdog-diagnostic.js";

const WATCHDOG_INTERVAL_MS = 60_000;

const configurationSchema = z
  .object({
    relayUrl: z
      .string()
      .url()
      .refine(isLoopbackHttpUrl, "relayUrl must be an explicit HTTP loopback origin"),
    credentialPath: z.string().min(1),
    synloqHome: z.string().min(1).optional(),
    language: languageSchema.optional(),
    kimiWork: kimiWorkConfigurationSchema.optional(),
    opencode: openCodeConfigurationSchema.optional(),
  })
  .strict()
  .superRefine((configuration, context) => {
    if (configuration.kimiWork && configuration.opencode) {
      context.addIssue({
        code: "custom",
        message: "kimiWork and opencode bindings are mutually exclusive",
      });
    }
    if (configuration.synloqHome && !configuration.kimiWork && !configuration.opencode) {
      context.addIssue({
        code: "custom",
        message: "Automatic relay requires a host binding (kimiWork or opencode)",
      });
    }
  });

export interface KimiWorkMcpBridge {
  runner: Pick<HttpAdapterRunner, "start" | "close"> & {
    onUnauthorized?: HttpAdapterRunner["onUnauthorized"];
  };
  adapter: Pick<KimiWorkAdapter, "close">;
}

export interface KimiWorkFactoryOptions {
  binding: ResolvedKimiWorkBinding;
  relay: RelayHttpClient;
  token: string;
  signal: AbortSignal;
  onUnauthorized: (error: SynloqError) => void;
  outstanding: OutstandingTracker;
  language?: Language;
}

export type KimiWorkFactory = (options: KimiWorkFactoryOptions) => Promise<KimiWorkMcpBridge>;

export interface McpStdioOptions {
  stdin?: Readable;
  stdout?: Writable;
  stderr?: Writable;
  kimiWorkFactory?: KimiWorkFactory;
  kimiWorkStartupAttempts?: number;
  kimiWorkRetryDelayMs?: number;
  kimiWorkRecoveryLimit?: number;
  kimiWorkRecoveryWindowMs?: number;
  kimiWorkRecoveryCooldownMs?: number;
  relayFactory?: typeof startRelaySupervisor;
}

interface McpConfiguration {
  relayUrl: string;
  token: string;
  synloqHome?: string;
  language?: Language;
  kimiWork?: ResolvedKimiWorkBinding;
  opencode?: ResolvedOpenCodeBinding;
}

async function readConfiguration(configPath: string): Promise<McpConfiguration> {
  let input: unknown;
  try {
    input = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new SynloqError("INVALID_INPUT", "MCP configuration contains malformed JSON");
    }
    throw error;
  }

  const configuration = configurationSchema.safeParse(input);
  if (!configuration.success) {
    throw new SynloqError("INVALID_INPUT", "MCP configuration does not match the schema");
  }

  const credentialPath = resolve(dirname(configPath), configuration.data.credentialPath);
  const token = (await readFile(credentialPath, "utf8")).trim();
  if (token === "") {
    throw new SynloqError("INVALID_INPUT", "MCP credential file is empty");
  }
  const kimiWork = configuration.data.kimiWork
    ? await resolveKimiWorkBinding(configPath, configuration.data.kimiWork)
    : undefined;
  const opencode = configuration.data.opencode
    ? await resolveOpenCodeBinding(configPath, configuration.data.opencode)
    : undefined;
  return {
    relayUrl: configuration.data.relayUrl,
    token,
    ...(configuration.data.synloqHome
      ? { synloqHome: resolve(dirname(configPath), configuration.data.synloqHome) }
      : {}),
    ...(configuration.data.language ? { language: configuration.data.language } : {}),
    ...(kimiWork ? { kimiWork } : {}),
    ...(opencode ? { opencode } : {}),
  };
}

async function defaultKimiWorkFactory(options: KimiWorkFactoryOptions): Promise<KimiWorkMcpBridge> {
  const participants = await loadManifest(options.binding.workspacePath);
  const project = participants[0]?.project;
  if (!project) throw new SynloqError("INVALID_INPUT", "Synloq manifest has no project");
  const adapter = await runKimiWorkAdapter(
    {
      ...options.binding,
      project,
      ...(options.language ? { language: options.language } : {}),
    },
    options.relay,
    {
      onUnauthorized: options.onUnauthorized,
    },
  );
  return {
    adapter,
    runner: new HttpAdapterRunner(
      options.relay,
      adapter,
      adapter.sessionBinding,
      undefined,
      undefined,
      options.outstanding,
    ),
  };
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

interface KimiWorkLifecycle {
  start(): void;
  stop(): Promise<void>;
  close(): Promise<void>;
}

function createKimiWorkLifecycle(
  binding: ResolvedKimiWorkBinding,
  relay: RelayHttpClient,
  token: string,
  options: McpStdioOptions,
  language?: Language,
): KimiWorkLifecycle {
  const factory = options.kimiWorkFactory ?? defaultKimiWorkFactory;
  const diagnostics = options.stderr ?? process.stderr;
  const attempts = Math.max(1, Math.floor(options.kimiWorkStartupAttempts ?? 5));
  const retryDelay = Math.max(0, options.kimiWorkRetryDelayMs ?? 200);
  // Recovery storms burn relay generations (observed: 1.5-3 re-registrations
  // per second during a client restart, issue #28). Cap recoveries per window;
  // beyond the limit the lifecycle cools down before re-registering again.
  const recoveryLimit = Math.max(1, Math.floor(options.kimiWorkRecoveryLimit ?? 5));
  const recoveryWindowMs = Math.max(1, options.kimiWorkRecoveryWindowMs ?? 60_000);
  const recoveryCooldownMs = Math.max(0, options.kimiWorkRecoveryCooldownMs ?? 60_000);
  const recoveryTimestamps: number[] = [];
  let abort: AbortController | undefined;
  let task: Promise<void> | undefined;
  let bridge: KimiWorkMcpBridge | undefined;
  let closePromise: Promise<void> | undefined;
  let closed = false;
  let recovering = false;
  const outstanding = new OutstandingTracker();

  const recover = (error: SynloqError) => {
    if (closed || recovering) return;
    recovering = true;
    const raw = `${error.code}: ${error.message}`;
    const detail = token === "" ? raw : raw.split(token).join("[redacted]");
    diagnostics.write(
      `${formatDiagnostic(`Synloq Kimi Work binding rejected by the relay for ${binding.conversationKey}, re-registering: ${detail}`)}\n`,
    );
    void (async () => {
      try {
        const now = Date.now();
        while (recoveryTimestamps.length > 0 && now - recoveryTimestamps[0]! >= recoveryWindowMs) {
          recoveryTimestamps.shift();
        }
        recoveryTimestamps.push(now);
        if (recoveryTimestamps.length > recoveryLimit) {
          diagnostics.write(
            `${formatDiagnostic(`Synloq Kimi Work recovery throttled for ${binding.conversationKey}: ${recoveryTimestamps.length} recoveries within ${recoveryWindowMs}ms, cooling down for ${recoveryCooldownMs}ms`)}\n`,
          );
          await abortableSleep(recoveryCooldownMs, new AbortController().signal);
          recoveryTimestamps.length = 0;
          if (closed) return;
        }
        await stop();
        start();
      } finally {
        recovering = false;
      }
    })();
  };

  const closeBridge = async (value: KimiWorkMcpBridge | undefined) => {
    if (!value) return;
    try {
      await value.runner.close();
    } finally {
      await value.adapter.close();
    }
  };

  const start = () => {
    if (closed || task) return;
    const controller = new AbortController();
    abort = controller;
    const startup = (async () => {
      for (let attempt = 1; attempt <= attempts && !controller.signal.aborted; attempt += 1) {
        try {
          const created = await factory({
            binding,
            relay,
            token,
            signal: controller.signal,
            onUnauthorized: recover,
            outstanding,
            ...(language ? { language } : {}),
          });
          if (controller.signal.aborted || closed) {
            await closeBridge(created);
            return;
          }
          bridge = created;
          created.runner.onUnauthorized = recover;
          created.runner.start();
          return;
        } catch (error) {
          if (controller.signal.aborted || closed) return;
          const raw =
            error instanceof SynloqError
              ? `${error.code}: ${error.message}`
              : error instanceof Error
                ? error.message
                : String(error);
          const detail = token === "" ? raw : raw.split(token).join("[redacted]");
          diagnostics.write(
            `${formatDiagnostic(`Synloq Kimi Work startup attempt ${attempt}/${attempts} failed for ${binding.conversationKey}: ${detail}`)}\n`,
          );
          if (attempt === attempts) {
            diagnostics.write(
              `${formatDiagnostic(`Synloq Kimi Work visible delivery unavailable for ${binding.conversationKey}`)}\n`,
            );
            return;
          }
          await abortableSleep(retryDelay * 2 ** (attempt - 1), controller.signal);
        }
      }
    })();
    task = startup;
    void startup.finally(() => {
      if (task === startup) task = undefined;
    });
  };

  const stop = async () => {
    const controller = abort;
    abort = undefined;
    controller?.abort();
    const startup = task;
    task = undefined;
    if (startup) {
      await Promise.race([startup, abortableSleep(1_000, new AbortController().signal)]);
    }
    const current = bridge;
    bridge = undefined;
    await closeBridge(current);
  };

  return {
    start,
    stop,
    close: () => {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = stop();
      return closePromise;
    },
  };
}

export async function startMcpStdio(
  configPath: string,
  options: McpStdioOptions = {},
): Promise<McpServer> {
  const configuration = await readConfiguration(configPath);
  const diagnostics = options.stderr ?? process.stderr;
  const hostWorkspace =
    configuration.kimiWork?.workspacePath ?? configuration.opencode?.workspacePath;
  let restoreCwd: (() => void) | undefined;
  if (hostWorkspace !== undefined && process.cwd() !== hostWorkspace) {
    // Hosts spawn channel processes with a cwd inside the installed plugin
    // directory; on Windows that locks the directory and breaks plugin
    // updates with EBUSY (issue #36). All our paths are absolute, so moving
    // the working directory to the project root is safe. The relay owner
    // branch below runs in this same process, so this covers it too.
    const previousCwd = process.cwd();
    try {
      process.chdir(hostWorkspace);
      // Restoring on close keeps the function embeddable (tests, future
      // in-process callers); a real channel exits right after close anyway.
      restoreCwd = () => {
        try {
          process.chdir(previousCwd);
        } catch {
          // The previous directory may be gone; nothing sensible to do.
        }
      };
    } catch (error) {
      diagnostics.write(
        `${formatDiagnostic(
          `Synloq could not move the process working directory to the project root: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )}\n`,
      );
    }
  }
  let lifecycle: KimiWorkLifecycle | undefined;
  let supervisor: RelaySupervisorLoop | undefined;
  let watchdogTimer: ReturnType<typeof setInterval> | undefined;
  if (configuration.synloqHome && hostWorkspace) {
    const participants = await loadManifest(hostWorkspace);
    const project = participants[0]?.project;
    if (!project) throw new SynloqError("INVALID_INPUT", "Synloq manifest has no project");
    const relayFactory = options.relayFactory ?? startRelaySupervisor;
    supervisor = await relayFactory({
      projectRoot: hostWorkspace,
      project,
      relayUrl: configuration.relayUrl,
      token: configuration.token,
      synloqHome: configuration.synloqHome,
      onOwnerLost: async () => lifecycle?.stop(),
      onRecovered: () => lifecycle?.start(),
      onDiagnostic: (message) => diagnostics.write(`${formatDiagnostic(message)}\n`),
    });
    const agentId = configuration.kimiWork?.agentId ?? configuration.opencode?.agentId;
    if (agentId) {
      const paths = await projectPaths(hostWorkspace, configuration.synloqHome);
      const watchdog = createWatchdogDiagnostic({
        project,
        agentId,
        participants,
        databasePath: paths.database,
        diagnostics,
      });
      watchdogTimer = setInterval(() => watchdog.check(), WATCHDOG_INTERVAL_MS);
      watchdogTimer.unref?.();
    }
  }

  const client =
    supervisor?.client ?? new RelayHttpClient(configuration.relayUrl, () => configuration.token);
  const server = new McpServer({ name: "synloq", version: "0.1.0" });
  registerSynloqTools(server, client);
  try {
    await server.connect(new StdioServerTransport(options.stdin, options.stdout));
  } catch (error) {
    await supervisor?.close();
    restoreCwd?.();
    throw error;
  }
  if (configuration.kimiWork) {
    lifecycle = createKimiWorkLifecycle(
      configuration.kimiWork,
      client,
      configuration.token,
      options,
      configuration.language,
    );
    lifecycle.start();
  }
  const previousClose = server.server.onclose;
  server.server.onclose = () => {
    previousClose?.();
    if (watchdogTimer) clearInterval(watchdogTimer);
    void (async () => {
      await lifecycle?.close();
      await supervisor?.close();
      restoreCwd?.();
    })();
  };
  diagnostics.write(`${formatDiagnostic("Synloq MCP stdio bridge ready")}\n`);
  return server;
}

async function main(): Promise<void> {
  const configPath = process.argv[2];
  if (configPath === undefined) {
    process.stderr.write("Usage: node dist/mcp/stdio.js <config-path>\n");
    process.exitCode = 1;
    return;
  }

  try {
    await startMcpStdio(configPath);
  } catch (error) {
    const detail =
      error instanceof SynloqError
        ? `${error.code}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
    process.stderr.write(
      `${formatDiagnostic(`Synloq MCP stdio bridge failed to start: ${detail}`)}\n`,
    );
    process.exitCode = 1;
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  await main();
}
