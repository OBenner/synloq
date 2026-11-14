#!/usr/bin/env node

import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { CodexJsonRpcConnection, CodexRpcError } from "./codex-app-server/json-rpc.ts";

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export type CodexCommandRunner = (
  command: string,
  args: readonly string[],
  cwd: string,
) => Promise<CommandResult>;

interface MetadataArtifact {
  available: boolean;
  bytes: number;
  sha256: string;
}

export interface CodexProbeReport {
  observedAt: string;
  codexVersion: string;
  appServerHelp: MetadataArtifact;
  appServerSchema: MetadataArtifact;
  initialize: unknown;
  resume?:
    | { status: "attached"; threadId: string }
    | { status: "writer-conflict" | "error"; errorCode?: number };
  resumeRead?: { status: "read" } | { status: "error"; errorCode?: number };
  resumeSkippedReason?: "thread-id-not-provided";
  activeDeliveryClaim: false;
  reason: "visible-session-submission-not-verified";
}

export interface CodexProbeOptions {
  cwd: string;
  threadId?: string;
  codexBin?: string;
  spawnProcess?: typeof spawn;
  commandRunner?: CodexCommandRunner;
  observedAt?: () => string;
  timeoutMs?: number;
}

function createDefaultCommandRunner(timeoutMs: number): CodexCommandRunner {
  return (command, args, cwd) =>
    new Promise((resolveCommand, reject) => {
      execFile(
        command,
        [...args],
        {
          cwd,
          encoding: "utf8",
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
          killSignal: "SIGKILL",
        },
        (error, stdout, stderr) => {
          if (error) reject(new Error("Codex metadata command failed"));
          else resolveCommand({ stdout, stderr });
        },
      );
    });
}

function metadataArtifact(stdout: string): MetadataArtifact {
  return {
    available: true,
    bytes: Buffer.byteLength(stdout, "utf8"),
    sha256: createHash("sha256").update(stdout, "utf8").digest("hex"),
  };
}

function unavailableArtifact(): MetadataArtifact {
  return { available: false, bytes: 0, sha256: "" };
}

async function metadata(
  commandRunner: CodexCommandRunner,
  codexBin: string,
  cwd: string,
): Promise<Pick<CodexProbeReport, "codexVersion" | "appServerHelp" | "appServerSchema">> {
  const codexVersion = await commandRunner(codexBin, ["--version"], cwd).then(
    ({ stdout }) => stdout.split(/\r?\n/, 1)[0]?.trim().slice(0, 256) || "unknown",
    () => "unknown",
  );
  const appServerHelp = await commandRunner(codexBin, ["app-server", "--help"], cwd).then(
    ({ stdout }) => metadataArtifact(stdout),
    () => unavailableArtifact(),
  );
  const appServerSchema = await commandRunner(
    codexBin,
    ["app-server", "generate-json-schema"],
    cwd,
  ).then(
    ({ stdout }) => metadataArtifact(stdout),
    () => unavailableArtifact(),
  );
  return { codexVersion, appServerHelp, appServerSchema };
}

/**
 * Key blocklist for the initialize response. Broad on purpose: the response
 * comes from a binary outside our control, so over-blocking is safe. Covers
 * content-bearing keys (prompt/text/turns) and credential-bearing keys
 * (token/secret/account/auth/credential/password/apiKey variants).
 */
const sensitiveInitializeKey =
  /prompt|text|turns|token|secret|account|auth|credential|password|api[-_]?key|cookie/i;

/**
 * Value-level defense for secrets hiding under innocuous keys: common token
 * shapes (sk-..., Bearer ..., JWT, long hex/base64 blobs) are redacted even
 * when the key does not match the blocklist.
 */
const sensitiveInitializeValue =
  /^(?:sk-[A-Za-z0-9_-]{8,}|Bearer\s+\S+|[A-Fa-f0-9]{40,}|[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})$/;

function sanitizeInitialize(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    if (sensitiveInitializeValue.test(value.trim())) return "[redacted]";
    return value.slice(0, 256);
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (depth >= 8) return "[depth-limit]";
  if (Array.isArray(value)) {
    return value.slice(0, 32).map((item) => sanitizeInitialize(item, depth + 1));
  }
  if (typeof value !== "object") return null;
  const entries: Array<[string, unknown]> = [];
  for (const [key, item] of Object.entries(value).slice(0, 64)) {
    if (!sensitiveInitializeKey.test(key)) {
      entries.push([key, sanitizeInitialize(item, depth + 1)]);
    }
  }
  return Object.fromEntries(entries);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function resumedThreadId(value: unknown): string | undefined {
  const thread = record(record(value)?.thread);
  return typeof thread?.id === "string" && thread.id !== "" ? thread.id : undefined;
}

type ProbeFailureStatus = "writer-conflict" | "error";

function probeFailure<S extends ProbeFailureStatus>(
  status: S,
  error: unknown,
): { status: S; errorCode?: number } {
  return error instanceof CodexRpcError && typeof error.rpcCode === "number"
    ? { status, errorCode: error.rpcCode }
    : { status };
}

function isWriterConflict(error: unknown): boolean {
  return error instanceof CodexRpcError && error.remoteDetail?.includes("active writer") === true;
}

export async function probeCodexAppServer(options: CodexProbeOptions): Promise<CodexProbeReport> {
  if (!isAbsolute(options.cwd)) throw new Error("--cwd must be an absolute project path");
  if (options.threadId === "") throw new Error("--thread-id must not be empty");
  if (options.codexBin === "") throw new Error("--codex-bin must not be empty");
  const timeoutMs = options.timeoutMs ?? 5_000;
  const codexBin = options.codexBin ?? "codex";
  const commandRunner = options.commandRunner ?? createDefaultCommandRunner(timeoutMs);
  const metadataResult = await metadata(commandRunner, codexBin, options.cwd);
  const child = (options.spawnProcess ?? spawn)(codexBin, ["app-server"], {
    cwd: options.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams;
  const connection = new CodexJsonRpcConnection(child, { timeoutMs });

  try {
    const initialize = sanitizeInitialize(
      await connection.request("initialize", {
        clientInfo: { name: "synloq-codex-probe", version: "0.1.0" },
        capabilities: { experimentalApi: false },
      }),
    );
    connection.notify("initialized", {});
    const report: CodexProbeReport = {
      ...metadataResult,
      observedAt: options.observedAt?.() ?? new Date().toISOString(),
      initialize,
      activeDeliveryClaim: false,
      reason: "visible-session-submission-not-verified",
    };

    if (options.threadId === undefined) {
      report.resumeSkippedReason = "thread-id-not-provided";
      return report;
    }

    try {
      const resumed = await connection.request("thread/resume", {
        threadId: options.threadId,
      });
      const threadId = resumedThreadId(resumed);
      if (threadId !== options.threadId) {
        report.resume = { status: "error" };
        return report;
      }
      report.resume = { status: "attached", threadId };
    } catch (error) {
      report.resume = probeFailure(isWriterConflict(error) ? "writer-conflict" : "error", error);
      return report;
    }

    try {
      await connection.request("thread/read", {
        threadId: options.threadId,
        includeTurns: false,
      });
      report.resumeRead = { status: "read" };
    } catch (error) {
      report.resumeRead = probeFailure("error", error);
    }
    return report;
  } finally {
    await connection.close();
  }
}

function parseCliOptions(args: string[]): CodexProbeOptions {
  const { values } = parseArgs({
    args,
    options: {
      cwd: { type: "string" },
      "thread-id": { type: "string" },
      "codex-bin": { type: "string" },
    },
    allowPositionals: false,
    strict: true,
  });
  if (!values.cwd) throw new Error("--cwd is required");
  const threadId = values["thread-id"];
  const codexBin = values["codex-bin"];
  if (threadId === "") throw new Error("--thread-id must not be empty");
  if (codexBin === "") throw new Error("--codex-bin must not be empty");
  return {
    cwd: values.cwd,
    ...(threadId === undefined ? {} : { threadId }),
    ...(codexBin === undefined ? {} : { codexBin }),
  };
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown failure";
  return message.replace(/[\r\n]+/g, " ").slice(0, 256);
}

async function runCli(): Promise<void> {
  try {
    const report = await probeCodexAppServer(parseCliOptions(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`Codex app-server probe failed: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  await runCli();
}
