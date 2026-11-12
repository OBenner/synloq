import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// The compiled CLI resolves the plugin template as ../../plugins/synloq relative
// to dist/init/plugin-renderer.js, i.e. <packageRoot>/plugins/synloq. The npm
// package must therefore ship plugins/ next to dist/ for `npx synloq init` to
// render role channels on a clean machine.
describe("npm package layout", () => {
  it("resolves the default plugin template inside the shipped package", async () => {
    const builtRenderer = join(packageRoot, "dist", "init", "plugin-renderer.js");
    const templatePath = fileURLToPath(
      new URL("../../plugins/synloq", `file://${builtRenderer.replaceAll("\\", "/")}`),
    );
    expect(templatePath).toBe(join(packageRoot, "plugins", "synloq"));
    expect(existsSync(join(templatePath, "kimi.plugin.json"))).toBe(true);
    expect(existsSync(join(templatePath, "locales", "zh-CN.json"))).toBe(true);
  });

  it("declares a publishable package that ships dist and plugins", async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
      private?: boolean;
      files?: string[];
      scripts?: Record<string, string>;
      bin?: Record<string, string>;
      repository?: { url?: string };
    };
    expect(manifest.private).not.toBe(true);
    expect(manifest.files).toEqual(expect.arrayContaining(["dist", "plugins"]));
    expect(manifest.scripts?.prepublishOnly).toBe("pnpm verify");
    expect(Object.values(manifest.bin ?? {}).every((entry) => entry.startsWith("dist/"))).toBe(
      true,
    );
    // npm --provenance requires the repository URL to match the publishing workflow.
    expect(manifest.repository?.url).toContain("github.com/OBenner/synloq");
  });
});
