import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startMcpStdio } from "../../src/mcp/stdio.js";

// Issue #36 (T1): host-spawned MCP processes inherit a cwd inside the plugin
// directory, which locks that directory on Windows and breaks plugin updates
// with EBUSY. The bridge must move its working directory to the project root
// as soon as the configuration is read.

const roots: string[] = [];
const originalCwd = process.cwd();

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function configuration(): Promise<{ root: string; configPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "synloq-mcp-chdir-"));
  roots.push(root);
  const credentialPath = join(root, "agent.token");
  const configPath = join(root, "mcp.json");
  await writeFile(credentialPath, "chdir-token\n", { mode: 0o600 });
  return { root, configPath };
}

function silentStderr(): { stderr: Writable; lines: () => string } {
  let captured = "";
  return {
    stderr: new Writable({
      write(chunk: Buffer, _encoding, callback) {
        captured += chunk.toString("utf8");
        callback();
      },
    }),
    lines: () => captured,
  };
}

describe("MCP stdio bridge working directory", () => {
  it("moves the process working directory to the kimiWork project root", async () => {
    const { root, configPath } = await configuration();
    await writeFile(
      configPath,
      JSON.stringify({
        relayUrl: "http://127.0.0.1:49152",
        credentialPath: join(root, "agent.token"),
        kimiWork: {
          projectRoot: root,
          agentId: "arch",
          conversationKey: "agent:main:main:conversation:d7be2b2c-edfc-4fc7-a010-1e7af6465138",
        },
      }),
    );
    const server = await startMcpStdio(configPath, {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: silentStderr().stderr,
      kimiWorkFactory: async () => ({
        runner: { start: vi.fn(), close: vi.fn(async () => undefined) },
        adapter: { close: vi.fn(async () => undefined) },
      }),
    });
    try {
      expect(process.cwd()).toBe(await realpath(root));
    } finally {
      await server.close();
    }
  });

  it("moves the process working directory to the opencode workspace", async () => {
    const { root, configPath } = await configuration();
    await writeFile(
      configPath,
      JSON.stringify({
        relayUrl: "http://127.0.0.1:49152",
        credentialPath: join(root, "agent.token"),
        opencode: {
          projectRoot: root,
          agentId: "tester",
        },
      }),
    );
    const server = await startMcpStdio(configPath, {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: silentStderr().stderr,
    });
    try {
      expect(process.cwd()).toBe(await realpath(root));
    } finally {
      await server.close();
    }
  });

  it("leaves the working directory untouched without a host binding", async () => {
    const { root, configPath } = await configuration();
    await writeFile(
      configPath,
      JSON.stringify({
        relayUrl: "http://127.0.0.1:49152",
        credentialPath: join(root, "agent.token"),
      }),
    );
    const server = await startMcpStdio(configPath, {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: silentStderr().stderr,
    });
    try {
      expect(process.cwd()).toBe(originalCwd);
    } finally {
      await server.close();
    }
  });

  it("keeps the bridge alive with a diagnostic when the project root is gone", async () => {
    const { root, configPath } = await configuration();
    await writeFile(
      configPath,
      JSON.stringify({
        relayUrl: "http://127.0.0.1:49152",
        credentialPath: join(root, "agent.token"),
        kimiWork: {
          projectRoot: join(root, "removed"),
          agentId: "arch",
          conversationKey: "agent:main:main:conversation:d7be2b2c-edfc-4fc7-a010-1e7af6465138",
        },
      }),
    );
    const capture = silentStderr();
    await expect(
      startMcpStdio(configPath, {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: capture.stderr,
      }),
    ).rejects.toThrow(/binding configuration is invalid/);
    // A vanished project root is rejected at binding resolution, before the
    // bridge ever tries to move the working directory.
    expect(capture.lines()).not.toContain("working directory");
  });
});
