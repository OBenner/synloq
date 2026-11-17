import { spawn } from "node:child_process";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ClaudeBinding } from "../../config/claude-nudger.js";

export interface ClaudeProcessResult {
  exitCode: number | null;
  stdout: string;
  interrupted: boolean;
}
export interface ClaudeProcessOptions {
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  limit?: number;
}
export type ClaudeRunner = typeof runClaudeProcess;
/** No shell, bounded output, no stderr persisted. Release ownership only after exit. */
export function runClaudeProcess(
  executable: string,
  args: string[],
  options: ClaudeProcessOptions,
): Promise<ClaudeProcessResult> {
  if (options.signal?.aborted)
    return Promise.resolve({ exitCode: null, stdout: "", interrupted: true });
  return new Promise((resolve) => {
    let stdout = "",
      bytes = 0,
      interrupted = false;
    const decoder = new StringDecoder("utf8");
    const child = spawn(executable, args, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const interrupt = () => {
      interrupted = true;
      child.kill("SIGKILL");
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const timer = setTimeout(interrupt, options.timeoutMs ?? 60_000);
    options.signal?.addEventListener("abort", interrupt, { once: true });
    const consume = (chunk: Buffer, keep: boolean) => {
      bytes += chunk.length;
      if (bytes > (options.limit ?? 4 * 1024 * 1024)) interrupt();
      else if (keep) stdout += decoder.write(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => consume(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => consume(chunk, false));
    child.on("error", () => {
      interrupted = true;
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", interrupt);
      resolve({ exitCode, stdout: stdout + decoder.end(), interrupted });
    });
  });
}

export function claudeNudgeArgs(binding: ClaudeBinding, prompt: string): string[] {
  const prefix = `mcp__synloq-${binding.agentId}__synloq_`;
  return [
    "-p",
    "--resume",
    binding.sessionId,
    "--mcp-config",
    binding.mcpConfig,
    "--strict-mcp-config",
    "--settings",
    binding.settings,
    "--output-format",
    "stream-json",
    "--verbose",
    "--tools",
    "",
    "--permission-mode",
    "default",
    "--disallowedTools",
    ["send", "reply", "list", "wait"].map((name) => prefix + name).join(","),
    "--allowedTools",
    `${prefix}inbox,${prefix}ack`,
    "--",
    prompt,
  ];
}

/** Conservative: any Claude process blocks, including an unidentifiable manual launch.
 * This reduces availability; it does not claim atomic exclusion of raw manual starts. */
export async function noClaudeProcesses(run: ClaudeRunner = runClaudeProcess): Promise<boolean> {
  const windows = process.platform === "win32";
  const executable = windows
    ? join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      )
    : "/bin/ps";
  const script =
    "$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process; if ($p | Where-Object { $_.Name -match '^claude(\\.exe)?$' -or ($_.Name -match '^node(\\.exe)?$' -and ($_.CommandLine -eq $null -or $_.CommandLine -match 'claude-code')) }) { 'busy' } else { 'clear' }";
  const result = await run(
    executable,
    windows ? ["-NoProfile", "-NonInteractive", "-Command", script] : ["-A", "-o", "pid=,args="],
    { timeoutMs: 5000, limit: 65536 },
  );
  if (result.interrupted || result.exitCode !== 0) return false;
  return windows
    ? result.stdout.trim() === "clear"
    : !result.stdout.split("\n").some((line) => {
        const match = /^\s*(\d+)\s+(.*)$/.exec(line);
        if (!match) return line.trim() !== "";
        if (Number(match[1]) === process.pid) return false;
        return /(?:^|[\/\s])claude(?:\s|$)|claude-code/i.test(match[2]!);
      });
}

export function classifyClaudeResult(
  result: ClaudeProcessResult,
  sessionId: string,
): "complete" | "external" | "denied" | "uncertain" | "invalid" {
  if (result.interrupted) return "uncertain";
  try {
    const rows = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    if (
      rows.some((row) => Array.isArray(row.permission_denials) && row.permission_denials.length > 0)
    )
      return "denied";
    const finals = rows.filter((row) => row.type === "result");
    if (finals.length !== 1) return "uncertain";
    const final = finals[0];
    if (final.session_id !== sessionId) return "invalid";
    if (
      final.is_error === false &&
      final.subtype === "success" &&
      result.exitCode === 0 &&
      Array.isArray(final.permission_denials)
    )
      return "complete";
    // Only typed provider evidence, never free-form stderr/text or an ambiguous timeout.
    if (
      rows.some(
        (row) =>
          row.type === "system" &&
          row.subtype === "api_error" &&
          (row.error?.status === 402 || row.error?.type === "api_connection_error"),
      ) &&
      !rows.some((row) => row.type === "assistant")
    )
      return "external";
    return "uncertain";
  } catch {
    return "uncertain";
  }
}
