import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { SynloqError } from "../domain/errors.js";
import { RelayHttpClient } from "../transport/http-client.js";
import { registerSynloqTools } from "./tools.js";

const configurationSchema = z
  .object({
    relayUrl: z.string().url(),
    credentialPath: z.string().min(1),
  })
  .strict();

export interface McpStdioOptions {
  stdin?: Readable;
  stdout?: Writable;
  stderr?: Writable;
}

async function readConfiguration(configPath: string): Promise<{ relayUrl: string; token: string }> {
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
  return { relayUrl: configuration.data.relayUrl, token };
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
