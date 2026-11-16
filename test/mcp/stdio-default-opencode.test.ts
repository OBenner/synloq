import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { runOpenCodeAdapter } from "../../src/adapters/opencode.js";
import { OutstandingTracker } from "../../src/adapters/http-runner.js";
import { writeManifest } from "../../src/config/manifest.js";
import { discoverOpenCodeHost } from "../../src/host/opencode/discovery.js";
import { defaultOpenCodeFactory } from "../../src/mcp/opencode-lifecycle.js";
import { RelayHttpClient } from "../../src/transport/http-client.js";

vi.mock("../../src/host/opencode/discovery.js", () => ({ discoverOpenCodeHost: vi.fn() }));
vi.mock("../../src/adapters/opencode.js", () => ({ runOpenCodeAdapter: vi.fn() }));

it("discovers the desktop endpoint and composes the default MCP adapter with exclusive ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "synloq-default-opencode-"));
  try {
    await writeManifest(root, [
      { project: "stand", agentId: "arch", title: "Architect", role: "Design" },
    ]);
    vi.mocked(discoverOpenCodeHost).mockResolvedValue({
      cliPath: "opencode",
      baseUrl: "http://127.0.0.1:4096",
      source: "path",
      authToken: "host-secret",
    });
    const adapter = {
      sessionBinding: { sessionId: "ses_arch", generation: 2 },
      close: vi.fn(async () => undefined),
      ping: vi.fn(),
    };
    vi.mocked(runOpenCodeAdapter).mockResolvedValue(adapter as never);
    const relay = new RelayHttpClient("http://127.0.0.1:4100", () => "relay-secret");
    const onUnauthorized = vi.fn();
    const composed = await defaultOpenCodeFactory({
      binding: { workspacePath: root, agentId: "arch", sessionId: "ses_arch" },
      relay,
      token: "relay-secret",
      signal: new AbortController().signal,
      onUnauthorized,
      outstanding: new OutstandingTracker(),
      diagnostics: { write: vi.fn() },
    });
    expect(runOpenCodeAdapter).toHaveBeenCalledWith(
      {
        project: "stand",
        agentId: "arch",
        sessionId: "ses_arch",
        baseUrl: "http://127.0.0.1:4096",
        authToken: "host-secret",
        ownership: "exclusive",
      },
      relay,
      undefined,
      onUnauthorized,
    );
    expect(composed.adapter).toBe(adapter);
    await composed.runner.close();
  } finally {
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  }
});
