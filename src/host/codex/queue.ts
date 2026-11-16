import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

// Undocumented CLI surface: expand only with a new reviewed fixture/probe.
export const CODEX_QUEUE_VERSIONS = ["0.169.0", "0.169.0-alpha.11.1"] as const;
export const CODEX_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const acceptance = /^Queued message ([0-9a-f-]+) for thread ([0-9a-f-]+)\.?\r?\n?$/;
const OUTPUT_LIMIT = 8192;

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  interrupted: boolean;
}

interface ProcessOptions {
  signal?: AbortSignal | undefined;
  timeoutMs?: number;
}

export type QueueResult =
  | { kind: "accepted"; queueId: string }
  | { kind: "disabled" | "rejected" | "uncertain" | "cancelled"; code: string };

/** Only the child we spawn is killed. Await close before releasing ownership. */
export function runQueueProcess(
  executable: string,
  args: string[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  if (options.signal?.aborted) {
    return Promise.resolve({ exitCode: null, stdout: "", interrupted: true });
  }
  return new Promise((resolve) => {
    let stdout = "";
    let bytes = 0;
    let interrupted = false;
    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const interrupt = () => {
      interrupted = true;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(interrupt, options.timeoutMs ?? 10_000);
    options.signal?.addEventListener("abort", interrupt, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > OUTPUT_LIMIT) interrupt();
      else stdout += chunk.toString("utf8");
    });
    // Drain but never expose stderr (it can contain paths, prompts or credentials).
    child.stderr.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > OUTPUT_LIMIT) interrupt();
    });
    child.on("error", () => {
      interrupted = true;
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", interrupt);
      resolve({ exitCode, stdout, interrupted });
    });
  });
}

export interface QueueNudgeOptions {
  executable: string;
  version: string;
  threadId: string;
  message: string;
  signal?: AbortSignal | undefined;
  beforeQueue?: () => boolean;
  run?: typeof runQueueProcess;
}

/** No retry, resume, daemon or turn observation. Acceptance never implies delivery. */
export async function queueCodexNudge(options: QueueNudgeOptions): Promise<QueueResult> {
  if (
    !isAbsolute(options.executable) ||
    !CODEX_UUID.test(options.threadId) ||
    !(CODEX_QUEUE_VERSIONS as readonly string[]).includes(options.version)
  ) {
    return { kind: "disabled", code: "INVALID_QUEUE_CONFIG" };
  }
  const run = options.run ?? runQueueProcess;
  try {
    // Check every time: an executable may be upgraded between nudge iterations.
    const version = await run(options.executable, ["--version"], { signal: options.signal });
    if (
      version.interrupted ||
      version.exitCode !== 0 ||
      ![
        `codex-cli ${options.version}`,
        `codex-cli ${options.version}\n`,
        `codex-cli ${options.version}\r\n`,
      ].includes(version.stdout)
    ) {
      return { kind: "disabled", code: "UNSUPPORTED_CLI_VERSION" };
    }
    if (options.signal?.aborted || options.beforeQueue?.() === false) {
      return { kind: "cancelled", code: "NO_LONGER_ELIGIBLE" };
    }
    const queued = await run(
      options.executable,
      ["queue", "--thread", options.threadId, "--message", options.message],
      { signal: options.signal },
    );
    if (queued.interrupted || queued.exitCode === null)
      return { kind: "uncertain", code: "QUEUE_INTERRUPTED" };
    if (queued.exitCode !== 0) return { kind: "rejected", code: "QUEUE_REJECTED" };
    const match = acceptance.exec(queued.stdout);
    if (
      !match ||
      match[0] !== queued.stdout ||
      !CODEX_UUID.test(match[1]!) ||
      match[2] !== options.threadId
    ) {
      return { kind: "uncertain", code: "QUEUE_OUTPUT_MISMATCH" };
    }
    return { kind: "accepted", queueId: match[1]! };
  } catch {
    // Throwing after spawn has the same ambiguity as losing its response.
    return { kind: "uncertain", code: "QUEUE_PROCESS_FAILURE" };
  }
}
