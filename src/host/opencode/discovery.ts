import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { SynloqError } from "../../domain/errors.js";

export interface OpenCodeHostEndpoint {
  cliPath: string;
  baseUrl: string;
  source: "override" | "bundled" | "path";
}

export type OpenCodeDiscoveryExec = (
  file: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number },
) => Promise<{ stdout: string }>;

export interface OpenCodeDiscoveryOptions {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  readdir?: (directory: string) => Promise<string[]>;
  exec?: OpenCodeDiscoveryExec;
}

const infoSchema = z.object({ urls: z.array(z.string().min(1)).min(1) }).passthrough();

const defaultExec: OpenCodeDiscoveryExec = (file, args, options) =>
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
        if (error) reject(new Error("opencode command failed"));
        else resolve({ stdout });
      },
    );
  });

const defaultReaddir = (directory: string): Promise<string[]> => readdir(directory);

function notFound(message: string): SynloqError {
  return new SynloqError("NOT_FOUND", message);
}

function loopbackHttpUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SynloqError("INVALID_INPUT", "OpenCode service URL is not a loopback HTTP URL");
  }
  if (
    url.protocol !== "http:" ||
    url.username !== "" ||
    url.password !== "" ||
    !["127.0.0.1", "::1", "[::1]", "localhost"].includes(url.hostname)
  ) {
    throw new SynloqError("INVALID_INPUT", "OpenCode service URL is not a loopback HTTP URL");
  }
  return value;
}

function jsonDocument(stdout: string): string {
  // The host CLI may prepend log lines to stdout before the JSON document; the
  // payload always starts at the first opening brace and runs to the end.
  const start = stdout.indexOf("{");
  if (start < 0) throw notFound("OpenCode service info is unavailable");
  return stdout.slice(start);
}

function parseVersion(entry: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)-x64$/.exec(entry);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function newestVersionedEntry(entries: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestVersion: [number, number, number] | undefined;
  for (const entry of entries) {
    const version = parseVersion(entry);
    if (!version) continue;
    if (
      !bestVersion ||
      version[0] > bestVersion[0] ||
      (version[0] === bestVersion[0] && version[1] > bestVersion[1]) ||
      (version[0] === bestVersion[0] &&
        version[1] === bestVersion[1] &&
        version[2] > bestVersion[2])
    ) {
      best = entry;
      bestVersion = version;
    }
  }
  return best;
}

async function bundledCli(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  read: (directory: string) => Promise<string[]>,
): Promise<string | undefined> {
  if (platform !== "win32") return undefined;
  const appData = environment.APPDATA;
  if (!appData) return undefined;
  const cliRoot = join(appData, "ai.opencode.desktop", "cli");
  let entries: string[];
  try {
    entries = await read(cliRoot);
  } catch {
    return undefined;
  }
  const newest = newestVersionedEntry(entries);
  return newest ? join(cliRoot, newest, "opencode-cli.exe") : undefined;
}

async function pathCli(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  exec: OpenCodeDiscoveryExec,
): Promise<string | undefined> {
  const locator = platform === "win32" ? "where" : "which";
  try {
    const { stdout } = await exec(locator, ["opencode"], {
      env: environment,
      timeout: 5_000,
      maxBuffer: 1_048_576,
    });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
  } catch {
    return undefined;
  }
}

async function serviceBaseUrl(
  cliPath: string,
  environment: NodeJS.ProcessEnv,
  exec: OpenCodeDiscoveryExec,
): Promise<string> {
  const { stdout } = await exec(cliPath, ["api", "get", "/api/info"], {
    env: environment,
    timeout: 10_000,
    maxBuffer: 1_048_576,
  });
  const parsed = infoSchema.parse(JSON.parse(jsonDocument(stdout)));
  const first = parsed.urls[0];
  if (!first) throw notFound("OpenCode service info is unavailable");
  return loopbackHttpUrl(first);
}

export async function discoverOpenCodeHost(
  options: OpenCodeDiscoveryOptions = {},
): Promise<OpenCodeHostEndpoint> {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const read = options.readdir ?? defaultReaddir;
  const exec = options.exec ?? defaultExec;

  const candidates: Array<{ cliPath: string; source: OpenCodeHostEndpoint["source"] }> = [];
  const override = environment.OPENCODE_EXECUTABLE;
  if (override && override.trim().length > 0) {
    candidates.push({ cliPath: override, source: "override" });
  }
  const bundled = await bundledCli(environment, platform, read);
  if (bundled) candidates.push({ cliPath: bundled, source: "bundled" });
  const onPath = await pathCli(environment, platform, exec);
  if (onPath && !candidates.some((candidate) => candidate.cliPath === onPath)) {
    candidates.push({ cliPath: onPath, source: "path" });
  }

  if (candidates.length === 0) {
    throw notFound(
      "OpenCode CLI is not available (no OPENCODE_EXECUTABLE override, no desktop-bundled CLI, no opencode on PATH)",
    );
  }

  for (const candidate of candidates) {
    try {
      const baseUrl = await serviceBaseUrl(candidate.cliPath, environment, exec);
      return { cliPath: candidate.cliPath, baseUrl, source: candidate.source };
    } catch (error) {
      if (error instanceof SynloqError && error.code === "INVALID_INPUT") throw error;
    }
  }
  throw notFound("OpenCode service is unavailable (is the OpenCode desktop app running?)");
}
