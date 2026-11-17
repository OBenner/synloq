import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectVersions } from "../../src/diagnostics/versions.js";
import { doctorCommand, statusCommand } from "../../src/cli/commands.js";
import { projectPaths } from "../../src/config/paths.js";
import { writeFileSync } from "node:fs";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const manifest = `project: verdicta
agents:
  cto:
    title: CTO
    role: Strategy
`;

function stand(): { root: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "synloq-versions-"));
  dirs.push(root);
  writeFileSync(join(root, "synloq.yaml"), manifest, "utf8");
  return { root, home: join(root, ".synloq") };
}

describe("version telemetry (#115)", () => {
  it("collects synloq/node/protocol/schema with an injected host probe", async () => {
    const { root, home } = stand();
    const paths = await projectPaths(root, home);
    // Materialize a real database so the schema probe has something to read.
    const { openDatabase } = await import("../../src/storage/sqlite.js");
    const database = openDatabase(paths.database);
    database.close();
    const block = await collectVersions({
      databasePath: paths.database,
      probe: async () => ({ opencode: "0.5.0", codex: "codex-cli 0.169.0" }),
    });
    expect(block.node).toMatch(/^v\d+/);
    expect(block.protocol).toBe(1);
    expect(block.schema).toBeDefined();
    expect(block.hosts.opencode).toBe("0.5.0");
    expect(block.hosts.codex).toContain("codex-cli");
  });

  it("fails soft: a throwing probe and a missing database yield no hosts and no schema", async () => {
    const dir = mkdtempSync(join(tmpdir(), "synloq-versions-soft-"));
    dirs.push(dir);
    const block = await collectVersions({
      databasePath: join(dir, "missing.sqlite"),
      probe: async () => {
        throw new Error("no CLIs here");
      },
    });
    expect(block.hosts).toEqual({});
    expect(block.schema).toBeUndefined();
    expect(block.node).toMatch(/^v\d+/);
  });

  it("embeds the versions block in doctor and status output", async () => {
    const { root, home } = stand();
    const probe = async () => ({ opencode: "0.5.0" });
    const doctor = await doctorCommand({
      projectRoot: root,
      synloqHome: home,
      hostVersionProbe: probe,
    });
    expect(doctor.versions?.protocol).toBe(1);
    expect(doctor.versions?.hosts.opencode).toBe("0.5.0");
    const status = await statusCommand({
      projectRoot: root,
      synloqHome: home,
      hostVersionProbe: probe,
    });
    expect(status.versions?.protocol).toBe(1);
    expect(status.versions?.hosts.opencode).toBe("0.5.0");
  });
});
