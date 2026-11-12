import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { runKimiWorkAdapter, type KimiWorkAdapter } from "../adapters/kimi-work.js";
import { HttpAdapterRunner } from "../adapters/http-runner.js";
import { loadManifest } from "../config/manifest.js";
import { SynloqError } from "../domain/errors.js";
import {
  kimiWorkConfigurationSchema,
  resolveKimiWorkBinding,
  type ResolvedKimiWorkBinding,
} from "../host/kimi-work/binding.js";
import { startRelaySupervisor, type RelaySupervisorLoop } from "../relay/supervisor-loop.js";
import { RelayHttpClient } from "../transport/http-client.js";
import { isLoopbackHttpUrl } from "../transport/loopback.js";
import { registerSynloqTools } from "./tools.js";

const configurationSchema = z
  .object({
    relayUrl: z
      .string()
      .url()
      .refine(isLoopbackHttpUrl, "relayUrl must be an explicit HTTP loopback origin"),
    credentialPath: z.string().min(1),
    synloqHome: z.string().min(1).optional(),
    kimiWork: kimiWorkConfigurationSchema.optional(),
  })
  .strict()
  .superRefine((configuration, context) => {
    if (configuration.synloqHome && !configuration.kimiWork) {
      context.addIssue({ code: "custom", message: "Automatic relay requires a Kimi Work binding" });
    }
  });

export interface KimiWorkMcpBridge {
  runner: Pick<HttpAdapterRunner, "start" | "close">;
  adapter: Pick<KimiWorkAdapter, "close">;
}

export interface KimiWorkFactoryOptions {
  binding: ResolvedKimiWorkBinding;
  relay: RelayHttpClient;
  token: string;
  signal: AbortSignal;
}

export type KimiWorkFactory = (options: KimiWorkFactoryOptions) => Promise<KimiWorkMcpBridge>;

export interface McpStdioOptions {
  stdin?: Readable;
  stdout?: Writable;
  stderr?: Writable;
  kimiWorkFactory?: KimiWorkFactory;
  kimiWorkStartupAttempts?: number;
  kimiWorkRetryDelayMs?: number;
  relayFactory?: typeof startRelaySupervisor;
}

interface McpConfiguration {
  relayUrl: string;
  token: string;
  synloqHome?: string;
  kimiWork?: ResolvedKimiWorkBinding;
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
  return {
    relayUrl: configuration.data.relayUrl,
    token,
    ...(configuration.data.synloqHome
      ? { synloqHome: resolve(dirname(configPath), configuration.data.synloqHome) }
      : {}),
    ...(kimiWork ? { kimiWork } : {}),
  };
}

async function defaultKimiWorkFactory(options: KimiWorkFactoryOptions): Promise<KimiWorkMcpBridge> {
  const participants = await loadManifest(options.binding.workspacePath);
  const project = participants[0]?.project;
  if (!project) throw new SynloqError("INVALID_INPUT", "Synloq manifest has no project");
  const adapter = await runKimiWorkAdapter({ ...options.binding, project }, options.relay);
  return {
    adapter,
    runner: new HttpAdapterRunner(options.relay, adapter, adapter.sessionBinding),
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
): KimiWorkLifecycle {
  const factory = options.kimiWorkFactory ?? defaultKimiWorkFactory;
  const diagnostics = options.stderr ?? process.stderr;
  const attempts = Math.max(1, Math.floor(options.kimiWorkStartupAttempts ?? 5));
  const retryDelay = Math.max(0, options.kimiWorkRetryDelayMs ?? 200);
  let abort: AbortController | undefined;
  let task: Promise<void> | undefined;
  let bridge: KimiWorkMcpBridge | undefined;
  let closePromise: Promise<void> | undefined;
  let closed = false;

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
          const created = await factory({ binding, relay, token, signal: controller.signal });
          if (controller.signal.aborted || closed) {
            await closeBridge(created);
            return;
          }
          bridge = created;
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
            `Synloq Kimi Work startup attempt ${attempt}/${attempts} failed for ${binding.conversationKey}: ${detail}\n`,
          );
          if (attempt === attempts) {
            diagnostics.write(
              `Synloq Kimi Work visible delivery unavailable for ${binding.conversationKey}\n`,
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
  let lifecycle: KimiWorkLifecycle | undefined;
  let supervisor: RelaySupervisorLoop | undefined;
  if (configuration.synloqHome && configuration.kimiWork) {
    const participants = await loadManifest(configuration.kimiWork.workspacePath);
    const project = participants[0]?.project;
    if (!project) throw new SynloqError("INVALID_INPUT", "Synloq manifest has no project");
    const relayFactory = options.relayFactory ?? startRelaySupervisor;
    supervisor = await relayFactory({
      projectRoot: configuration.kimiWork.workspacePath,
      project,
      relayUrl: configuration.relayUrl,
      token: configuration.token,
      synloqHome: configuration.synloqHome,
      onOwnerLost: async () => lifecycle?.stop(),
      onRecovered: () => lifecycle?.start(),
      onDiagnostic: (message) => diagnostics.write(`${message}\n`),
    });
  }

  const client =
    supervisor?.client ?? new RelayHttpClient(configuration.relayUrl, () => configuration.token);
  const server = new McpServer({ name: "synloq", version: "0.1.0" });
  registerSynloqTools(server, client);
  try {
    await server.connect(new StdioServerTransport(options.stdin, options.stdout));
  } catch (error) {
    await supervisor?.close();
    throw error;
  }
  if (configuration.kimiWork) {
    lifecycle = createKimiWorkLifecycle(
      configuration.kimiWork,
      client,
      configuration.token,
      options,
    );
    lifecycle.start();
  }
  const previousClose = server.server.onclose;
  server.server.onclose = () => {
    previousClose?.();
    void (async () => {
      await lifecycle?.close();
      await supervisor?.close();
    })();
  };
  diagnostics.write("Synloq MCP stdio bridge ready\n");
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
  } catch {
    process.stderr.write("Synloq MCP stdio bridge failed to start\n");
    process.exitCode = 1;
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  await main();
}
