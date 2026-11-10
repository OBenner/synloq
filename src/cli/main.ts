#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { z } from "zod";
import { CredentialStore } from "../config/credentials.js";
import { loadManifest } from "../config/manifest.js";
import { SynloqError } from "../domain/errors.js";
import { PROTOCOL_VERSION } from "../domain/session.js";
import { startMcpStdio } from "../mcp/stdio.js";
import { RelayHttpClient } from "../transport/http-client.js";
import {
  runStandaloneClaudeHook,
  startStandaloneAdapter,
  type StandaloneAdapterHandle,
} from "./adapter.js";
import {
  doctorCommand,
  inboxCommand,
  initCommand,
  listCommand,
  pauseCommand,
  replaceSessionCommand,
  resumeCommand,
  sendCommand,
  serveCommand,
} from "./commands.js";
import { formatDoctorReport } from "./doctor.js";

interface Output {
  write(chunk: string): boolean;
}

export interface CliIo {
  stdout: Output;
  stderr: Output;
}

export interface MainDependencies {
  startMcp?: (configPath: string) => Promise<unknown>;
  startAdapter?: (configPath: string) => Promise<StandaloneAdapterHandle>;
  runHook?: (configPath: string) => Promise<void>;
  waitForShutdown?: () => Promise<void>;
}

const commandNames = [
  "init",
  "serve",
  "mcp",
  "adapter",
  "claude-hook",
  "list",
  "inbox",
  "send",
  "pause",
  "resume",
  "replace-session",
  "doctor",
] as const;

type CommandName = (typeof commandNames)[number];
type Values = object;

const relayOptions: NonNullable<ParseArgsConfig["options"]> = {
  "relay-url": { type: "string" },
  token: { type: "string" },
  credential: { type: "string" },
  help: { type: "boolean", short: "h" },
};

const helpText: Record<CommandName, string> = {
  init: "Usage: synloq init --project-root <path>\n",
  serve: "Usage: synloq serve --project-root <path> [--host <127.0.0.1|::1>] [--port <number>]\n",
  mcp: "Usage: synloq mcp --config <path>\n",
  adapter: "Usage: synloq adapter --config <path>\n",
  "claude-hook": "Usage: synloq claude-hook --config <path>\n",
  list: "Usage: synloq list --relay-url <url> (--token <token> | --credential <path>)\n",
  inbox:
    "Usage: synloq inbox --relay-url <url> (--token <token> | --credential <path>) [--cursor <cursor>] [--limit <1-100>] [--wait-ms <0-25000>]\n",
  send: "Usage: synloq send --project-root <path> --relay-url <url> (--token <token> | --credential <path>) --to <agent-id> --text <text> --idempotency-key <key> [--expects-reply]\n",
  pause:
    "Usage: synloq pause --relay-url <url> (--token <token> | --credential <path>) --scope <project|participant|thread> [--scope-id <id>]\n",
  resume:
    "Usage: synloq resume --relay-url <url> (--token <token> | --credential <path>) --scope <project|participant|thread> [--scope-id <id>]\n",
  "replace-session":
    "Usage: synloq replace-session --relay-url <url> (--token <token> | --credential <path>) --agent-id <id> --session-id <id> --protocol-version <number> --active-delivery <true|false> --state-reporting <true|false> --client-idempotency <true|false>\n",
  doctor: "Usage: synloq doctor --project-root <path>\n",
};

function invalid(message: string): never {
  throw new SynloqError("INVALID_INPUT", message);
}

function parse(command: CommandName, args: string[], options: ParseArgsConfig["options"]) {
  return parseArgs({ args, options: { ...options, help: { type: "boolean", short: "h" } } });
}

function value(values: Values, name: string): unknown {
  return Reflect.get(values, name);
}

function requiredString(values: Values, name: string): string {
  const result = value(values, name);
  if (typeof result !== "string" || result === "") invalid(`--${name} is required`);
  return result;
}

function optionalString(values: Values, name: string): string | undefined {
  const result = value(values, name);
  if (result === undefined) return undefined;
  if (typeof result !== "string" || result === "") invalid(`--${name} must not be empty`);
  return result;
}

function numberOption(values: Values, name: string, fallback: number, maximum: number): number {
  const raw = optionalString(values, name);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) invalid(`--${name} must be an integer`);
  const result = Number(raw);
  if (!Number.isSafeInteger(result) || result > maximum) {
    invalid(`--${name} must be between 0 and ${maximum}`);
  }
  return result;
}

function booleanOption(values: Values, name: string): boolean {
  const raw = requiredString(values, name);
  if (raw !== "true" && raw !== "false") invalid(`--${name} must be true or false`);
  return raw === "true";
}

async function tokenFrom(values: Values): Promise<string> {
  const token = optionalString(values, "token");
  const credential = optionalString(values, "credential");
  if ((token === undefined) === (credential === undefined)) {
    invalid("exactly one of --token or --credential is required");
  }
  if (token !== undefined) return token;
  const result = (await readFile(credential as string, "utf8")).trim();
  if (!result) invalid("credential file is empty");
  return result;
}

async function clientFrom(values: Values): Promise<{ client: RelayHttpClient; token: string }> {
  const token = await tokenFrom(values);
  return {
    client: new RelayHttpClient(requiredString(values, "relay-url"), () => token),
    token,
  };
}

function writeJson(io: CliIo, result: unknown): void {
  io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function pauseInput(values: Values): {
  scope: "project" | "participant" | "thread";
  scopeId: string;
} {
  const scope = requiredString(values, "scope");
  if (scope !== "project" && scope !== "participant" && scope !== "thread") {
    invalid("--scope must be project, participant, or thread");
  }
  const scopeId = optionalString(values, "scope-id") ?? "";
  if (scope !== "project" && scopeId === "") invalid("--scope-id is required for this scope");
  if (scope === "project" && scopeId !== "") invalid("--scope-id is only valid for a named scope");
  return { scope, scopeId };
}

function waitForSignal(): Promise<void> {
  return new Promise((resolveSignal) => {
    const onSignal = () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      resolveSignal();
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
}

async function execute(
  command: CommandName,
  args: string[],
  io: CliIo,
  dependencies: MainDependencies,
): Promise<void> {
  if (command === "init") {
    const { values } = parse(command, args, { "project-root": { type: "string" } });
    if (value(values, "help")) {
      io.stdout.write(helpText[command]);
      return;
    }
    writeJson(io, await initCommand({ projectRoot: requiredString(values, "project-root") }));
    return;
  }

  if (command === "doctor") {
    const { values } = parse(command, args, { "project-root": { type: "string" } });
    if (value(values, "help")) {
      io.stdout.write(helpText[command]);
      return;
    }
    io.stdout.write(
      `${formatDoctorReport(await doctorCommand({ projectRoot: requiredString(values, "project-root") }))}\n`,
    );
    return;
  }

  if (command === "mcp") {
    const { values } = parse(command, args, { config: { type: "string" } });
    if (value(values, "help")) {
      io.stdout.write(helpText[command]);
      return;
    }
    await (dependencies.startMcp ?? startMcpStdio)(requiredString(values, "config"));
    return;
  }

  if (command === "claude-hook") {
    const { values } = parse(command, args, { config: { type: "string" } });
    if (value(values, "help")) {
      io.stdout.write(helpText[command]);
      return;
    }
    await (dependencies.runHook ?? runStandaloneClaudeHook)(requiredString(values, "config"));
    return;
  }

  if (command === "adapter") {
    const { values } = parse(command, args, { config: { type: "string" } });
    if (value(values, "help")) {
      io.stdout.write(helpText[command]);
      return;
    }
    const handle = await (dependencies.startAdapter ?? startStandaloneAdapter)(
      requiredString(values, "config"),
    );
    try {
      await (dependencies.waitForShutdown ?? waitForSignal)();
    } finally {
      await handle.close();
    }
    return;
  }

  if (command === "serve") {
    const { values } = parse(command, args, {
      "project-root": { type: "string" },
      host: { type: "string" },
      port: { type: "string" },
    });
    if (value(values, "help")) {
      io.stdout.write(helpText[command]);
      return;
    }
    const host = optionalString(values, "host");
    const handle = await serveCommand({
      projectRoot: requiredString(values, "project-root"),
      ...(host ? { host } : {}),
      port: numberOption(values, "port", 0, 65_535),
    });
    writeJson(io, { relayUrl: handle.baseUrl });
    try {
      await (dependencies.waitForShutdown ?? waitForSignal)();
    } finally {
      await handle.close();
    }
    return;
  }

  if (command === "list") {
    const { values } = parse(command, args, relayOptions);
    if (value(values, "help")) {
      io.stdout.write(helpText[command]);
      return;
    }
    const { client } = await clientFrom(values);
    writeJson(io, await listCommand(client));
    return;
  }

  if (command === "inbox") {
    const { values } = parse(command, args, {
      ...relayOptions,
      cursor: { type: "string" },
      limit: { type: "string" },
      "wait-ms": { type: "string" },
    });
    if (value(values, "help")) {
      io.stdout.write(helpText[command]);
      return;
    }
    const { client } = await clientFrom(values);
    const limit = numberOption(values, "limit", 50, 100);
    if (limit < 1) invalid("--limit must be between 1 and 100");
    const waitMs = numberOption(values, "wait-ms", 0, 25_000);
    const cursor = optionalString(values, "cursor");
    writeJson(io, await inboxCommand(client, { limit, waitMs, ...(cursor ? { cursor } : {}) }));
    return;
  }

  if (command === "send") {
    const { values } = parse(command, args, {
      ...relayOptions,
      "project-root": { type: "string" },
      to: { type: "string" },
      text: { type: "string" },
      "idempotency-key": { type: "string" },
      "expects-reply": { type: "boolean" },
    });
    if (value(values, "help")) {
      io.stdout.write(helpText[command]);
      return;
    }
    const projectRoot = requiredString(values, "project-root");
    const participants = await loadManifest(projectRoot);
    const project = participants[0]?.project;
    if (!project) invalid("manifest must declare at least one agent");
    const { client, token } = await clientFrom(values);
    const identity = await new CredentialStore(projectRoot).authenticate(project, token);
    writeJson(
      io,
      await sendCommand(
        client,
        {
          to: requiredString(values, "to"),
          text: requiredString(values, "text"),
          expectsReply: value(values, "expects-reply") === true,
          idempotencyKey: requiredString(values, "idempotency-key"),
        },
        identity,
      ),
    );
    return;
  }

  if (command === "pause" || command === "resume") {
    const { values } = parse(command, args, {
      ...relayOptions,
      scope: { type: "string" },
      "scope-id": { type: "string" },
    });
    if (value(values, "help")) {
      io.stdout.write(helpText[command]);
      return;
    }
    const { client } = await clientFrom(values);
    const operation = command === "pause" ? pauseCommand : resumeCommand;
    writeJson(io, await operation(client, pauseInput(values)));
    return;
  }

  const { values } = parse(command, args, {
    ...relayOptions,
    "agent-id": { type: "string" },
    "session-id": { type: "string" },
    "protocol-version": { type: "string" },
    "active-delivery": { type: "string" },
    "state-reporting": { type: "string" },
    "client-idempotency": { type: "string" },
  });
  if (value(values, "help")) {
    io.stdout.write(helpText[command]);
    return;
  }
  const { client } = await clientFrom(values);
  const protocolVersion = numberOption(values, "protocol-version", PROTOCOL_VERSION, 1_000_000);
  if (protocolVersion < 1) invalid("--protocol-version must be positive");
  writeJson(
    io,
    await replaceSessionCommand(client, {
      agentId: requiredString(values, "agent-id"),
      sessionId: requiredString(values, "session-id"),
      protocolVersion,
      capabilities: {
        activeDelivery: booleanOption(values, "active-delivery"),
        stateReporting: booleanOption(values, "state-reporting"),
        clientIdempotency: booleanOption(values, "client-idempotency"),
      },
    }),
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof SynloqError) return error.message;
  if (error instanceof z.ZodError) return "command input validation failed";
  if (error instanceof TypeError) return error.message;
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.message;
  }
  return "command failed";
}

export async function runMain(
  argv: string[] = process.argv.slice(2),
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
  dependencies: MainDependencies = {},
): Promise<number> {
  const command = argv[0];
  if (command === "--help" || command === "-h" || command === undefined) {
    io.stdout.write(`Usage: synloq <command> [options]\nCommands: ${commandNames.join(", ")}\n`);
    return command === undefined ? 1 : 0;
  }
  if (!commandNames.includes(command as CommandName)) {
    io.stderr.write(`synloq: unknown command: ${command}\n`);
    return 1;
  }

  try {
    await execute(command as CommandName, argv.slice(1), io, dependencies);
    return 0;
  } catch (error) {
    io.stderr.write(`synloq: ${errorMessage(error)}\n`);
    return 1;
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  process.exitCode = await runMain();
}
