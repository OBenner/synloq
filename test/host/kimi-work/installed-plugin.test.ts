import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkPluginFreshness,
  defaultPluginsRegistryPath,
} from "../../../src/host/kimi-work/installed-plugin.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{
  source: string;
  installed: string;
  registryPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "synloq-freshness-"));
  roots.push(root);
  const source = join(root, "plugin-source");
  const installed = join(root, "plugins", "managed", "synloq");
  await mkdir(source, { recursive: true });
  await mkdir(installed, { recursive: true });
  const registryPath = join(root, "plugins", "installed.json");
  return { source, installed, registryPath };
}

async function writeRegistry(registryPath: string, entries: unknown[]): Promise<void> {
  await writeFile(registryPath, JSON.stringify({ version: 1, plugins: entries }), "utf8");
}

async function writePluginManifest(root: string, version: string): Promise<void> {
  await writeFile(join(root, "kimi.plugin.json"), JSON.stringify({ version }), "utf8");
}

describe("checkPluginFreshness", () => {
  it("reports stale=false when the installed copy matches the source", async () => {
    const { source, installed, registryPath } = await fixture();
    await writePluginManifest(source, "0.1.0+local.abc.111111111111");
    await writePluginManifest(installed, "0.1.0+local.abc.111111111111");
    await writeRegistry(registryPath, [{ id: "synloq", root: installed, originalSource: source }]);

    const result = await checkPluginFreshness(source, { registryPath });
    expect(result.stale).toBe(false);
    expect(result.sourceVersion).toBe("0.1.0+local.abc.111111111111");
    expect(result.installedVersion).toBe("0.1.0+local.abc.111111111111");
    expect(result.note).toBeUndefined();
  });

  it("flags a stale installed copy with both versions", async () => {
    const { source, installed, registryPath } = await fixture();
    await writePluginManifest(source, "0.1.0+local.abc.222222222222");
    await writePluginManifest(installed, "0.1.0+local.abc.111111111111");
    await writeRegistry(registryPath, [{ id: "synloq", root: installed, originalSource: source }]);

    const result = await checkPluginFreshness(source, { registryPath });
    expect(result.stale).toBe(true);
    expect(result.installedPath).toBe(installed);
  });

  it("matches the registry entry case-insensitively on Windows paths", async () => {
    const { source, installed, registryPath } = await fixture();
    await writePluginManifest(source, "0.1.0+local.abc.111111111111");
    await writePluginManifest(installed, "0.1.0+local.abc.111111111111");
    await writeRegistry(registryPath, [
      { id: "synloq", root: installed, originalSource: source.toUpperCase() },
    ]);

    const result = await checkPluginFreshness(source, { registryPath, platform: "win32" });
    expect(result.stale).toBe(false);
    expect(result.note).toBeUndefined();
  });

  it("notes a missing source manifest without flagging stale", async () => {
    const { source, registryPath } = await fixture();
    const result = await checkPluginFreshness(source, { registryPath });
    expect(result.stale).toBe(false);
    expect(result.note).toBe("source-manifest-missing");
  });

  it("notes an unreadable registry without flagging stale", async () => {
    const { source, registryPath } = await fixture();
    await writePluginManifest(source, "0.1.0+local.abc.111111111111");
    const result = await checkPluginFreshness(source, { registryPath });
    expect(result.stale).toBe(false);
    expect(result.note).toBe("registry-unreadable");
  });

  it("notes when the plugin is absent from the registry", async () => {
    const { source, installed, registryPath } = await fixture();
    await writePluginManifest(source, "0.1.0+local.abc.111111111111");
    await writePluginManifest(installed, "0.1.0+local.abc.111111111111");
    await writeRegistry(registryPath, [
      { id: "synloq", root: installed, originalSource: join(installed, "elsewhere") },
    ]);

    const result = await checkPluginFreshness(source, { registryPath });
    expect(result.stale).toBe(false);
    expect(result.note).toBe("not-installed");
  });

  it("treats a missing installed manifest as stale", async () => {
    const { source, installed, registryPath } = await fixture();
    await writePluginManifest(source, "0.1.0+local.abc.111111111111");
    await writeRegistry(registryPath, [{ id: "synloq", root: installed, originalSource: source }]);

    const result = await checkPluginFreshness(source, { registryPath });
    expect(result.stale).toBe(true);
    expect(result.installedVersion).toBeUndefined();
  });
});

describe("defaultPluginsRegistryPath", () => {
  it("builds the Windows path under APPDATA", () => {
    const path = defaultPluginsRegistryPath({ APPDATA: "C:\\Users\\x\\AppData\\Roaming" }, "win32");
    expect(path).toContain("kimi-desktop");
    expect(path.endsWith("installed.json")).toBe(true);
  });
});
