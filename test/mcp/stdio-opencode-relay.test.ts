import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { writeManifest } from "../../src/config/manifest.js";
import { startMcpStdio } from "../../src/mcp/stdio.js";
import type {
  RelaySupervisorLoop,
  StartRelaySupervisorOptions,
} from "../../src/relay/supervisor-loop.js";
import { RelayHttpClient } from "../../src/transport/http-client.js";

const stderr = () => new Writable({ write: (_chunk, _encoding, callback) => callback() });

async function writeConfig(home: string, config: Record<string, unknown>): Promise<string> {
  const credentialPath = join(home, "arch.token");
  const configPath = join(home, "mcp.json");
  await writeFile(credentialPath, "test-token\n", { mode: 0o600 });
  await writeFile(configPath, JSON.stringify({ credentialPath, ...config }));
  return configPath;
}

describe("MCP automatic relay lifecycle for OpenCode bindings", () => {
  it("starts the relay supervisor for an opencode binding without a Kimi lifecycle", async () => {
    const root = await mkdtemp(join(tmpdir(), "synloq-mcp-opencode-project-"));
    const home = await mkdtemp(join(tmpdir(), "synloq-mcp-opencode-home-"));
    await writeManifest(root, [
      { project: "stand", agentId: "arch", title: "Architect", role: "Designs the system" },
    ]);
    const configPath = await writeConfig(home, {
      relayUrl: "http://127.0.0.1:4100",
      synloqHome: home,
      opencode: { projectRoot: root, agentId: "arch", sessionId: "ses_1" },
    });

    const events: string[] = [];
    let supervisorOptions: StartRelaySupervisorOptions | undefined;
    const supervisor: RelaySupervisorLoop = {
      client: new RelayHttpClient("http://127.0.0.1:4100", () => "test-token"),
      owned: true,
      close: vi.fn(async () => {
        events.push("relay-close");
      }),
    };
    const relayFactory = vi.fn(async (options: StartRelaySupervisorOptions) => {
      events.push("relay-start");
      supervisorOptions = options;
      return supervisor;
    });
    const kimiWorkFactory = vi.fn();

    const server = await startMcpStdio(configPath, {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: stderr(),
      relayFactory,
      kimiWorkFactory: kimiWorkFactory as never,
    });

    expect(events).toEqual(["relay-start"]);
    expect(supervisorOptions).toMatchObject({
      projectRoot: root,
      project: "stand",
      relayUrl: "http://127.0.0.1:4100",
      synloqHome: home,
    });
    expect(kimiWorkFactory).not.toHaveBeenCalled();

    await server.close();
    await vi.waitFor(() => expect(events).toContain("relay-close"));
  });

  it("accepts an opencode binding without a sessionId (init before the service is reachable)", async () => {
    const root = await mkdtemp(join(tmpdir(), "synloq-mcp-opencode-project-"));
    const home = await mkdtemp(join(tmpdir(), "synloq-mcp-opencode-home-"));
    await writeManifest(root, [
      { project: "stand", agentId: "arch", title: "Architect", role: "Designs the system" },
    ]);
    const configPath = await writeConfig(home, {
      relayUrl: "http://127.0.0.1:4100",
      synloqHome: home,
      opencode: { projectRoot: root, agentId: "arch" },
    });

    const supervisor: RelaySupervisorLoop = {
      client: new RelayHttpClient("http://127.0.0.1:4100", () => "test-token"),
      owned: true,
      close: vi.fn(async () => undefined),
    };
    const relayFactory = vi.fn(async () => supervisor);

    const server = await startMcpStdio(configPath, {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: stderr(),
      relayFactory,
    });
    expect(relayFactory).toHaveBeenCalledTimes(1);
    await server.close();
  });

  it("rejects kimiWork and opencode bindings in the same config", async () => {
    const root = await mkdtemp(join(tmpdir(), "synloq-mcp-opencode-project-"));
    const home = await mkdtemp(join(tmpdir(), "synloq-mcp-opencode-home-"));
    const configPath = await writeConfig(home, {
      relayUrl: "http://127.0.0.1:4100",
      synloqHome: home,
      kimiWork: {
        projectRoot: root,
        agentId: "arch",
        conversationKey: "agent:main:main:conversation:d7be2b2c-edfc-4fc7-a010-1e7af6465138",
      },
      opencode: { projectRoot: root, agentId: "arch" },
    });

    const relayFactory = vi.fn();
    await expect(
      startMcpStdio(configPath, {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: stderr(),
        relayFactory: relayFactory as never,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(relayFactory).not.toHaveBeenCalled();
  });

  it("rejects synloqHome without any host binding", async () => {
    const home = await mkdtemp(join(tmpdir(), "synloq-mcp-opencode-home-"));
    const configPath = await writeConfig(home, {
      relayUrl: "http://127.0.0.1:4100",
      synloqHome: home,
    });

    const relayFactory = vi.fn();
    await expect(
      startMcpStdio(configPath, {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: stderr(),
        relayFactory: relayFactory as never,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(relayFactory).not.toHaveBeenCalled();
  });
});
