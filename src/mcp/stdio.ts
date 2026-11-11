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
import { RelayHttpClient } from "../transport/http-client.js";
import { registerSynloqTools } from "./tools.js";

const configurationSchema = z
  .object({
    relayUrl: z.string().url(),
    credentialPath: z.string().min(1),
    kimiWork: kimiWorkConfigurationSchema.optional(),
  })
  .strict();

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
}

async function readConfiguration(
  configPath: string,
): Promise<{ relayUrl: string; token: string; kimiWork?: ResolvedKimiWorkBinding }> {
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
  return { relayUrl: configuration.data.relayUrl, token, ...(kimiWork ? { kimiWork } : {}) };
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

function attachKimiWorkLifecycle(
  server: McpServer,
  binding: ResolvedKimiWorkBinding,
  relay: RelayHttpClient,
  token: string,
  options: McpStdioOptions,
): void {
  const factory = options.kimiWorkFactory ?? defaultKimiWorkFactory;
  const abort = new AbortController();
  const diagnostics = options.stderr ?? process.stderr;
  const attempts = Math.max(1, Math.floor(options.kimiWorkStartupAttempts ?? 5));
  const retryDelay = Math.max(0, options.kimiWorkRetryDelayMs ?? 200);
  let bridge: KimiWorkMcpBridge | undefined;
  let cleanupPromise: Promise<void> | undefined;

  const closeBridge = async (value: KimiWorkMcpBridge | undefined) => {
    if (!value) return;
    await value.runner.close();
    await value.adapter.close();
  };

  const startup = (async () => {
    for (let attempt = 1; attempt <= attempts && !abort.signal.aborted; attempt += 1) {
      try {
        const created = await factory({ binding, relay, token, signal: abort.signal });
        if (abort.signal.aborted) {
          await closeBridge(created);
          return;
        }
        bridge = created;
        created.runner.start();
        return;
      } catch {
        if (abort.signal.aborted) return;
        if (attempt === attempts) {
          diagnostics.write(
            `Synloq Kimi Work visible delivery unavailable for ${binding.conversationKey}\n`,
          );
          return;
        }
        await abortableSleep(retryDelay * 2 ** (attempt - 1), abort.signal);
      }
    }
  })();

  const cleanup = () => {
    if (cleanupPromise) return cleanupPromise;
    abort.abort();
    cleanupPromise = (async () => {
      await Promise.race([startup, abortableSleep(1_000, new AbortController().signal)]);
      await closeBridge(bridge);
    })();
    return cleanupPromise;
  };
  const previousClose = server.server.onclose;
  server.server.onclose = () => {
    previousClose?.();
    void cleanup();
  };
}

export async function startMcpStdio(
  configPath: string,
  options: McpStdioOptions = {},
): Promise<McpServer> {
  const configuration = await readConfiguration(configPath);
  const client = new RelayHttpClient(configuration.relayUrl, () => configuration.token);
  const server = new McpServer({ name: "synloq", version: "0.1.0" });
  registerSynloqTools(server, client);
  await server.connect(new StdioServerTransport(options.stdin, options.stdout));
  if (configuration.kimiWork) {
    attachKimiWorkLifecycle(server, configuration.kimiWork, client, configuration.token, options);
  }
  (options.stderr ?? process.stderr).write("Synloq MCP stdio bridge ready\n");
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
