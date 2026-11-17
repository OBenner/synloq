import { afterEach, expect, it, vi } from "vitest";
import { RelayHttpClient } from "../../src/transport/http-client.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerSynloqTools } from "../../src/mcp/tools.js";
import { startRelaySupervisor } from "../../src/relay/supervisor-loop.js";
import { SynloqError } from "../../src/domain/errors.js";
afterEach(() => vi.unstubAllGlobals());
it("MCP exposes a structured actionable error without serializing its private cause", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(Object.assign(new Error("private-token"), { code: "ECONNREFUSED" })),
  );
  const server = new McpServer({ name: "test", version: "1" });
  registerSynloqTools(
    server,
    new RelayHttpClient("http://127.0.0.1:62000", () => "private-token", {
      project: "test",
      agentId: "cto",
    }),
  );
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  try {
    const result = await client.callTool({ name: "synloq_inbox", arguments: {} });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: "STORAGE_FAILURE",
          message: expect.stringContaining("relay unreachable (ECONNREFUSED)"),
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("private-token");
  } finally {
    await client.close();
    await server.close();
  }
});
it("exhausted supervisor logs the failure category, not private exception text", async () => {
  const diagnostic = vi.fn();
  const close = vi.fn();
  const client = {
    listParticipants: vi.fn().mockRejectedValue(new Error("down")),
  } as unknown as RelayHttpClient;
  const ensure = vi
    .fn()
    .mockResolvedValueOnce({ baseUrl: "http://127.0.0.1:62000", owned: false, client, close })
    .mockRejectedValue(new SynloqError("ALREADY_RUNNING", "private-token"));
  const loop = await startRelaySupervisor({
    projectRoot: "unused",
    project: "test",
    token: "private-token",
    relayUrl: "http://127.0.0.1:62000",
    ensure,
    onDiagnostic: diagnostic,
    monitorIntervalMs: 1,
    maxReconnectAttempts: 1,
  });
  try {
    await vi.waitFor(() =>
      expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining("ALREADY_RUNNING")),
    );
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("private-token");
    expect(ensure).toHaveBeenCalledTimes(2);
  } finally {
    await loop.close();
  }
});
it("reports relay unreachable with a safe cause while retaining ECONNREFUSED for supervisor election", async () => {
  const cause = Object.assign(new Error("must-not-leak-token"), { code: "ECONNREFUSED" });
  const failure = new TypeError("fetch failed", { cause });
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(failure));
  const client = new RelayHttpClient("http://127.0.0.1:62000", () => "must-not-leak-token", {
    project: "test",
    agentId: "cto",
  });
  const error = await client.listParticipants().catch((e: unknown) => e);
  expect(error).toMatchObject({ code: "STORAGE_FAILURE", cause: failure });
  expect((error as Error).message).toContain("relay unreachable");
  expect((error as Error).message).toContain("ECONNREFUSED");
  expect((error as Error).message).not.toContain("must-not-leak-token");
});
it("preserves caller cancellation", async () => {
  const abort = new DOMException("cancelled", "AbortError");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abort));
  const client = new RelayHttpClient("http://127.0.0.1:62000", () => "test", {
    project: "test",
    agentId: "cto",
  });
  await expect(client.listParticipants()).rejects.toBe(abort);
});
