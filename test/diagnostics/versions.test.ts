import { mkdtempSync, rmSync } from "node:fs";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSupportedNode,
  collectVersions,
  isSupportedNode,
} from "../../src/diagnostics/versions.js";
import { doctorCommand, serveCommand, statusCommand } from "../../src/cli/commands.js";
import { runGenericInit } from "../../src/cli/init-cli.js";
import { projectPaths } from "../../src/config/paths.js";

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

describe("Node version gate (#111)", () => {
  it("evaluates the runtime floor: 22 fails, 24+ pass", () => {
    expect(isSupportedNode("v22.11.0")).toBe(false);
    expect(isSupportedNode("v24.0.0")).toBe(true);
    expect(isSupportedNode("v25.3.1")).toBe(true);
    expect(isSupportedNode("not-a-version")).toBe(false);
    expect(() => assertSupportedNode("v22.11.0")).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(() => assertSupportedNode("v22.11.0")).toThrowError(/Node\.js 24/);
    expect(() => assertSupportedNode(process.version)).not.toThrow();
  });

  it("doctor reports nodeSupported for the injected runtime", async () => {
    const { root, home } = stand();
    const doctor = await doctorCommand({
      projectRoot: root,
      synloqHome: home,
      hostVersionProbe: async () => ({}),
      nodeVersion: "v22.11.0",
    });
    expect(doctor.versions?.node).toBe("v22.11.0");
    expect(doctor.versions?.nodeSupported).toBe(false);

    const healthy = await doctorCommand({
      projectRoot: root,
      synloqHome: home,
      hostVersionProbe: async () => ({}),
    });
    expect(healthy.versions?.nodeSupported).toBe(true);
  });

  it("serve refuses an old runtime before any write", async () => {
    const { root, home } = stand();
    await expect(
      serveCommand({ projectRoot: root, synloqHome: home, port: 0, nodeVersion: "v22.11.0" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", message: expect.stringContaining("24") });
    // Nothing was written: no database file appeared.
    const paths = await projectPaths(root, home);
    expect(existsSync(paths.database)).toBe(false);
  });

  it("init refuses an old runtime before any write", async () => {
    const { root, home } = stand();
    const output: string[] = [];
    await expect(
      runGenericInit(
        ["--project-root", root, "--synloq-home", home, "--non-interactive"],
        {
          stdout: {
            write: (text) => {
              output.push(text);
              return true;
            },
          },
        },
        { nodeVersion: "v22.11.0" },
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", message: expect.stringContaining("24") });
    expect(existsSync(join(home, "credentials"))).toBe(false);
  });
});
