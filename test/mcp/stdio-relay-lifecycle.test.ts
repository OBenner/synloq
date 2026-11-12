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

const conversationKey = "agent:main:main:conversation:d7be2b2c-edfc-4fc7-a010-1e7af6465138";

describe("MCP automatic relay lifecycle", () => {
  it("rejects a non-loopback relayUrl before any relay or host startup", async () => {
    const home = await mkdtemp(join(tmpdir(), "synloq-mcp-config-home-"));
    const credentialPath = join(home, "reviewer.token");
    const configPath = join(home, "mcp.json");
    await writeFile(credentialPath, "test-token\n", { mode: 0o600 });
    await writeFile(
      configPath,
      JSON.stringify({
        relayUrl: "http://example.com:4100",
        credentialPath,
      }),
    );

    const relayFactory = vi.fn();
    await expect(
      startMcpStdio(configPath, {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new Writable({ write: (_chunk, _encoding, callback) => callback() }),
        relayFactory: relayFactory as never,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(relayFactory).not.toHaveBeenCalled();
  });

  it("starts relay before host, recovers registration, and closes in reverse order", async () => {
    const root = await mkdtemp(join(tmpdir(), "synloq-mcp-relay-project-"));
    const home = await mkdtemp(join(tmpdir(), "synloq-mcp-relay-home-"));
    await writeManifest(root, [
      { project: "example", agentId: "reviewer", title: "Reviewer", role: "Review evidence" },
    ]);
    const credentialPath = join(home, "reviewer.token");
    const configPath = join(home, "mcp.json");
    await writeFile(credentialPath, "test-token\n", { mode: 0o600 });
    await writeFile(
      configPath,
      JSON.stringify({
        relayUrl: "http://127.0.0.1:4100",
        credentialPath,
        synloqHome: home,
        kimiWork: {
          projectRoot: root,
          agentId: "reviewer",
          conversationKey,
          workAgentId: "main",
        },
      }),
    );

    const events: string[] = [];
    let lifecycleOptions: StartRelaySupervisorOptions | undefined;
    const supervisor: RelaySupervisorLoop = {
      client: new RelayHttpClient("http://127.0.0.1:4100", () => "test-token"),
      owned: true,
      close: vi.fn(async () => {
        events.push("relay-close");
      }),
    };
    const relayFactory = vi.fn(async (options: StartRelaySupervisorOptions) => {
      events.push("relay-start");
      lifecycleOptions = options;
      return supervisor;
    });
    const kimiWorkFactory = vi.fn(async () => {
      events.push("host-start");
      return {
        runner: {
          start: vi.fn(),
          close: vi.fn(async () => {
            events.push("runner-close");
          }),
        },
        adapter: {
          close: vi.fn(async () => {
            events.push("adapter-close");
          }),
        },
      };
    });
    const server = await startMcpStdio(configPath, {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new Writable({ write: (_chunk, _encoding, callback) => callback() }),
      relayFactory,
      kimiWorkFactory,
    });

    await vi.waitFor(() => expect(events).toEqual(["relay-start", "host-start"]));
    expect(lifecycleOptions).toMatchObject({
      projectRoot: root,
      project: "example",
      synloqHome: home,
    });
    expect(process.env.SYNLOQ_HOME).not.toBe(home);

    await lifecycleOptions?.onOwnerLost?.();
    expect(events).toContain("runner-close");
    expect(events).toContain("adapter-close");
    await lifecycleOptions?.onRecovered?.();
    await vi.waitFor(() => expect(kimiWorkFactory).toHaveBeenCalledTimes(2));

    await server.close();
    await vi.waitFor(() => expect(events).toContain("relay-close"));
    expect(events.indexOf("runner-close")).toBeLessThan(events.lastIndexOf("relay-close"));
    expect(events.indexOf("adapter-close")).toBeLessThan(events.lastIndexOf("relay-close"));
  });
});
