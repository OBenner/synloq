import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runKimiWorkAdapter } from "../../src/adapters/kimi-work.js";
import { startMcpStdio } from "../../src/mcp/stdio.js";

vi.mock("../../src/adapters/kimi-work.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/adapters/kimi-work.js")>();
  return { ...actual, runKimiWorkAdapter: vi.fn() };
});

const roots: string[] = [];
const runKimiWorkAdapterMock = vi.mocked(runKimiWorkAdapter);

afterEach(async () => {
  runKimiWorkAdapterMock.mockReset();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("default Kimi Work MCP bridge", () => {
  it("starts with the declared role without a second local credential-store authentication", async () => {
    const root = await mkdtemp(join(tmpdir(), "synloq-mcp-default-kimi-"));
    roots.push(root);
    vi.stubEnv("SYNLOQ_HOME", join(root, "empty-home"));
    await writeFile(
      join(root, "synloq.yaml"),
      "version: 1\nproject: synloq\nagents:\n  arch:\n    title: Architect\n    role: Review\n",
    );
    const configPath = join(root, "mcp.json");
    await writeFile(join(root, "agent.token"), "relay-only-token\n");
    await writeFile(
      configPath,
      JSON.stringify({
        relayUrl: "http://127.0.0.1:49152",
        credentialPath: join(root, "agent.token"),
        kimiWork: {
          projectRoot: root,
          agentId: "arch",
          conversationKey: "agent:main:main:conversation:d7be2b2c-edfc-4fc7-a010-1e7af6465138",
          workAgentId: "main",
        },
      }),
    );
    const adapter = {
      capabilities: { activeDelivery: false, stateReporting: false, clientIdempotency: false },
      sessionBinding: {
        sessionId: "agent:main:main:conversation:d7be2b2c-edfc-4fc7-a010-1e7af6465138",
        generation: 1,
      },
      close: vi.fn(async () => undefined),
    };
    runKimiWorkAdapterMock.mockResolvedValue(adapter as never);

    const server = await startMcpStdio(configPath, {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new Writable({ write: (_chunk, _encoding, callback) => callback() }),
      kimiWorkStartupAttempts: 1,
    });

    await vi.waitFor(() => expect(runKimiWorkAdapterMock).toHaveBeenCalledTimes(1));
    expect(runKimiWorkAdapterMock).toHaveBeenCalledWith(
      expect.objectContaining({ project: "synloq", agentId: "arch" }),
      expect.anything(),
      expect.objectContaining({ onUnauthorized: expect.any(Function) }),
    );
    await server.close();
  });
});
