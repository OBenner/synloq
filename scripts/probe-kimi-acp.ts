#!/usr/bin/env node

import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const OPERATION_TIMEOUT_MS = 5000;
const MAX_NDJSON_BUFFER_BYTES = 1024 * 1024;

export interface KimiAcpReport {
  kimiVersion: string;
  observedAt: string;
  initialize: unknown;
  resumeResult?: unknown;
  resumeSkippedReason?: string;
  activeDeliveryClaim: false;
  reason: "existing-tui-interaction-not-verified";
}

export type SpawnKimiAcp = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcessWithoutNullStreams;

export interface KimiAcpProbeOptions {
  cwd: string;
  sessionId?: string;
  spawnProcess?: SpawnKimiAcp;
  observedAt?: () => string;
}

interface PendingRequest {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const defaultSpawn: SpawnKimiAcp = (command, args, options) =>
  spawn(command, args, options) as ChildProcessWithoutNullStreams;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class AcpConnection {
  child: ChildProcessWithoutNullStreams;
  nextId = 1;
  buffered = "";
  failure: Error | undefined;
  pending = new Map<number, PendingRequest>();

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.receive(chunk));
    child.once("error", (error) => this.fail(new Error(`kimi acp failed: ${errorMessage(error)}`)));
    child.once("exit", (code, signal) => {
      this.fail(new Error(`kimi acp exited before a response (code=${code}, signal=${signal})`));
    });
    child.stdin.once("error", (error) =>
      this.fail(new Error(`kimi acp stdin failed: ${errorMessage(error)}`)),
    );
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.fail(new Error(`${method} timed out after ${OPERATION_TIMEOUT_MS} ms`));
      }, OPERATION_TIMEOUT_MS);
      this.pending.set(id, {
        method,
        resolve: resolveRequest,
        reject: rejectRequest,
        timer,
      });
      try {
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        rejectRequest(new Error(`${method} could not be sent: ${errorMessage(error)}`));
      }
    });
  }

  receive(chunk: string): void {
    if (this.failure) return;
    this.buffered += chunk;
    if (Buffer.byteLength(this.buffered, "utf8") > MAX_NDJSON_BUFFER_BYTES) {
      this.fail(new Error("kimi acp NDJSON buffer exceeded 1048576 bytes"));
      return;
    }
    while (true) {
      const newline = this.buffered.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffered.slice(0, newline);
      this.buffered = this.buffered.slice(newline + 1);
      if (line.trim() === "") continue;

      let response: unknown;
      try {
        response = JSON.parse(line);
      } catch (error) {
        this.fail(new Error(`kimi acp returned invalid NDJSON: ${errorMessage(error)}`));
        return;
      }
      this.receiveResponse(response);
      if (this.failure) return;
    }
  }

  receiveResponse(value: unknown): void {
    const response = record(value);
    if (!response || typeof response.id !== "number" || Object.hasOwn(response, "method")) return;
    const request = this.pending.get(response.id);
    if (!request) return;
    this.pending.delete(response.id);
    clearTimeout(request.timer);

    const rpcError = record(response.error);
    if (rpcError) {
      const detail = typeof rpcError.message === "string" ? rpcError.message : "unknown error";
      request.reject(new Error(`${request.method} failed: ${detail}`));
      return;
    }
    if (!Object.hasOwn(response, "result")) {
      request.reject(new Error(`${request.method} returned no result`));
      return;
    }
    request.resolve(response.result);
  }

  fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
}

function negotiatedVersion(initialize: unknown): number | undefined {
  const version = record(initialize)?.protocolVersion;
  return typeof version === "number" ? version : undefined;
}

function resumeSupported(initialize: unknown): boolean {
  const result = record(initialize);
  const version = negotiatedVersion(initialize);
  if (version === 1) {
    const capabilities = record(result?.agentCapabilities);
    const sessionCapabilities = record(capabilities?.sessionCapabilities);
    return record(sessionCapabilities?.resume) !== undefined;
  }
  if (version === 2) {
    const capabilities = record(result?.capabilities);
    return record(capabilities?.session) !== undefined;
  }
  return false;
}

function kimiVersion(initialize: unknown): string {
  const result = record(initialize);
  const info = record(negotiatedVersion(initialize) === 2 ? result?.info : result?.agentInfo);
  return typeof info?.version === "string" && info.version !== "" ? info.version : "unknown";
}

export async function probeKimiAcp(options: KimiAcpProbeOptions): Promise<KimiAcpReport> {
  if (!isAbsolute(options.cwd)) throw new Error("--cwd must be an absolute project path");
  if (options.sessionId === "") throw new Error("--session-id must not be empty");

  const child = (options.spawnProcess ?? defaultSpawn)("kimi", ["acp"], {
    cwd: options.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const connection = new AcpConnection(child);
  try {
    const initialize = await connection.request("initialize", {
      protocolVersion: 2,
      capabilities: {},
      info: { name: "synloq-kimi-acp-probe", version: "0.1.0" },
    });
    const report: KimiAcpReport = {
      kimiVersion: kimiVersion(initialize),
      observedAt: options.observedAt?.() ?? new Date().toISOString(),
      initialize,
      activeDeliveryClaim: false,
      reason: "existing-tui-interaction-not-verified",
    };

    if (options.sessionId === undefined) {
      report.resumeSkippedReason = "session-id-not-provided";
    } else {
      const version = negotiatedVersion(initialize);
      if (version !== 1 && version !== 2) {
        report.resumeSkippedReason = "unsupported-protocol-version";
      } else if (!resumeSupported(initialize)) {
        report.resumeSkippedReason = "resume-unsupported";
      } else {
        report.resumeResult = await connection.request("session/resume", {
          sessionId: options.sessionId,
          cwd: options.cwd,
          mcpServers: [],
        });
      }
    }
    return report;
  } finally {
    child.kill();
  }
}

function parseCliOptions(args: string[]): KimiAcpProbeOptions {
  const { values } = parseArgs({
    args,
    options: {
      cwd: { type: "string" },
      "session-id": { type: "string" },
    },
    allowPositionals: false,
    strict: true,
  });
  if (!values.cwd) throw new Error("--cwd is required");
  const sessionId = values["session-id"];
  return {
    cwd: values.cwd,
    ...(sessionId === undefined ? {} : { sessionId }),
  };
}

async function runCli(): Promise<void> {
  try {
    const report = await probeKimiAcp(parseCliOptions(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`Kimi ACP probe failed: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  await runCli();
}
