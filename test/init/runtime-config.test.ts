import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { relativeConfigPath } from "../../src/init/runtime-config.js";

describe("relativeConfigPath", () => {
  it("renders the target relative to the config dir, forward slashes only", async () => {
    const base = await mkdtemp(join(tmpdir(), "synloq-relpath-"));
    const configDir = join(base, "runtime", "key", "mcp");
    const target = join(base, "project");

    const rendered = relativeConfigPath(configDir, target);

    expect(rendered).not.toContain("\\");
    expect(rendered).not.toBe(target);
    expect(resolve(configDir, rendered)).toBe(resolve(target));
  });

  it("falls back to the absolute target when no relative form exists", async () => {
    const same = await mkdtemp(join(tmpdir(), "synloq-relpath-same-"));
    // Identical directories have no relative spelling.
    expect(relativeConfigPath(same, same)).toBe(same);
  });
});
