import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

// Issue #36 (b): doctor flags a stale installed plugin copy. Kimi Work keeps
// personal plugins in a source directory and copies them into the runtime
// plugins registry on Install/Update; the registry file maps the installed
// root back to the original source. All checks here are local file reads —
// doctor stays offline-safe.

export interface InstalledPluginEntry {
  id: string;
  root: string;
  originalSource?: string;
}

export interface PluginFreshness {
  sourcePath: string;
  sourceVersion?: string;
  installedPath?: string;
  installedVersion?: string;
  // True only when an installed copy was found and its version differs from
  // the source — the operator must press Install/Update.
  stale: boolean;
  note?: "source-manifest-missing" | "registry-unreadable" | "not-installed";
}

export function defaultPluginsRegistryPath(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    const appData = environment.APPDATA;
    if (!appData) throw new Error("APPDATA is not set");
    return join(
      appData,
      "kimi-desktop",
      "daimon-share",
      "daimon",
      "runtime",
      "kimi-code",
      "home",
      "plugins",
      "installed.json",
    );
  }
  return join(
    environment.HOME ?? homedir(),
    ".kimi",
    "daimon",
    "runtime",
    "kimi-code",
    "home",
    "plugins",
    "installed.json",
  );
}

function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  const normalize = (value: string) => {
    const resolved = resolve(value);
    return platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

async function readPluginVersion(pluginRoot: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(await readFile(join(pluginRoot, "kimi.plugin.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof manifest.version === "string" ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

export async function checkPluginFreshness(
  pluginSourcePath: string,
  options: {
    registryPath?: string;
    environment?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
  } = {},
): Promise<PluginFreshness> {
  const platform = options.platform ?? process.platform;
  const sourcePath = resolve(pluginSourcePath);
  const sourceVersion = await readPluginVersion(sourcePath);
  if (sourceVersion === undefined) {
    return { sourcePath, stale: false, note: "source-manifest-missing" };
  }

  let registryRaw: string;
  try {
    const registryPath =
      options.registryPath ??
      defaultPluginsRegistryPath(options.environment ?? process.env, platform);
    registryRaw = await readFile(registryPath, "utf8");
  } catch {
    return { sourcePath, sourceVersion, stale: false, note: "registry-unreadable" };
  }

  let entries: InstalledPluginEntry[];
  try {
    const parsed = JSON.parse(registryRaw) as { plugins?: InstalledPluginEntry[] };
    entries = Array.isArray(parsed.plugins) ? parsed.plugins : [];
  } catch {
    return { sourcePath, sourceVersion, stale: false, note: "registry-unreadable" };
  }

  const installed = entries.find(
    (entry) =>
      (entry.id === "synloq" || entry.originalSource !== undefined) &&
      entry.originalSource !== undefined &&
      isAbsolute(entry.originalSource) &&
      samePath(entry.originalSource, sourcePath, platform),
  );
  if (!installed) {
    return { sourcePath, sourceVersion, stale: false, note: "not-installed" };
  }

  const installedVersion = await readPluginVersion(installed.root);
  return {
    sourcePath,
    sourceVersion,
    installedPath: installed.root,
    ...(installedVersion === undefined ? {} : { installedVersion }),
    // A missing installed manifest cannot match — treat as stale.
    stale: installedVersion !== sourceVersion,
  };
}
