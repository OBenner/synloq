import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { SynloqError } from "../../domain/errors.js";

export interface KimiWorkControlEndpoint {
  url: string;
  token: string;
}

export interface KimiWorkStatusExecOptions {
  env: NodeJS.ProcessEnv;
  timeout: number;
  maxBuffer: number;
}

export type KimiWorkStatusExec = (
  file: string,
  args: readonly string[],
  options: KimiWorkStatusExecOptions,
) => Promise<{ stdout: string }>;

export interface KimiWorkStatusOptions {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  exec?: KimiWorkStatusExec;
}

const statusSchema = z
  .object({
    control: z
      .object({
        endpoint: z
          .object({
            url: z.string(),
            auth: z.object({ token: z.string().min(1) }).passthrough(),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

const defaultExec: KimiWorkStatusExec = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        env: options.env,
        timeout: options.timeout,
        maxBuffer: options.maxBuffer,
        encoding: "utf8",
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) reject(new Error("status command failed"));
        else resolve({ stdout });
      },
    );
  });

function unavailable(): SynloqError {
  return new SynloqError("NOT_FOUND", "Kimi Work local-control status is unavailable");
}

function loopbackWebSocket(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SynloqError(
      "INVALID_INPUT",
      "Kimi Work control endpoint is not a loopback WebSocket",
    );
  }
  if (
    url.protocol !== "ws:" ||
    url.username !== "" ||
    url.password !== "" ||
    !["127.0.0.1", "::1", "[::1]"].includes(url.hostname)
  ) {
    throw new SynloqError(
      "INVALID_INPUT",
      "Kimi Work control endpoint is not a loopback WebSocket",
    );
  }
  return value;
}

export async function loadKimiWorkControlEndpoint(
  options: KimiWorkStatusOptions = {},
): Promise<KimiWorkControlEndpoint> {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const exec = options.exec ?? defaultExec;
  try {
    const windows = platform === "win32";
    const config = windows
      ? (environment.KIMI_WORK_CONFIG ??
        join(
          environment.APPDATA ?? unavailableThrow(),
          "kimi-desktop",
          "daimon-share",
          "daimon",
          "config.json",
        ))
      : (environment.KIMI_WORK_CONFIG ??
        join(environment.HOME ?? homedir(), ".kimi", "daimon", "config.json"));
    const file = windows
      ? (environment.KIMI_WORK_EXECUTABLE ??
        join(environment.LOCALAPPDATA ?? unavailableThrow(), "Programs", "Kimi", "Kimi.exe"))
      : (environment.KIMI_WORK_EXECUTABLE ?? "kimi-daimon");
    const args = windows
      ? [
          environment.KIMI_WORK_CLI ??
            join(
              environment.APPDATA ?? unavailableThrow(),
              "kimi-desktop",
              "daimon-bundle",
              "app",
              "daimon",
              "dist",
              "src",
              "runner",
              "cli.js",
            ),
          "--config",
          config,
          "status",
          "--json",
        ]
      : ["--config", config, "status", "--json"];
    const env: NodeJS.ProcessEnv = windows
      ? { ...environment, ELECTRON_RUN_AS_NODE: "1" }
      : { ...environment };
    delete env.ELECTRON_RUN_AS_NODE;
    if (windows) env.ELECTRON_RUN_AS_NODE = "1";
    const { stdout } = await exec(file, args, { env, timeout: 5_000, maxBuffer: 1_048_576 });
    const parsed = statusSchema.parse(JSON.parse(jsonDocument(stdout)));
    return {
      url: loopbackWebSocket(parsed.control.endpoint.url),
      token: parsed.control.endpoint.auth.token,
    };
  } catch (error) {
    if (error instanceof SynloqError && error.code === "INVALID_INPUT") throw error;
    throw unavailable();
  }
}

function unavailableThrow(): never {
  throw unavailable();
}

function jsonDocument(stdout: string): string {
  // The host CLI may prepend log lines (e.g. startup observations) to stdout
  // before the JSON document; the status payload always starts at the first
  // opening brace and runs to the end of the output.
  const start = stdout.indexOf("{");
  if (start < 0) throw unavailable();
  return stdout.slice(start);
}
