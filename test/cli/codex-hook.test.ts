import { Readable, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runCodexHook } from "../../src/cli/codex-hook.js";
import { runMain, type CliIo } from "../../src/cli/main.js";
import { PROTOCOL_VERSION } from "../../src/domain/session.js";
import type { RelayHttpClient } from "../../src/transport/http-client.js";

const config = { project: "verdicta", agentId: "cto", sessionId: "codex-thread-1" };

function fakeClient() {
  const session = {
    project: config.project,
    agentId: config.agentId,
    sessionId: config.sessionId,
    generation: 3,
  };
  const registerSession = vi.fn().mockResolvedValue({ session });
  const heartbeat = vi.fn().mockResolvedValue({ session });
  return {
    registerSession,
    heartbeat,
    client: { registerSession, heartbeat } as unknown as RelayHttpClient,
  };
}

async function invoke(client: RelayHttpClient, input: string | Record<string, unknown>) {
  let stdout = "";
  const output = new Writable({
    write(chunk, _encoding, callback) {
      stdout += String(chunk);
      callback();
    },
  });
  await runCodexHook(client, config, {
    stdin: Readable.from([typeof input === "string" ? input : JSON.stringify(input)]),
    stdout: output,
  });
  return stdout;
}

describe("Codex hook", () => {
  it("registers inactive state reporting and then heartbeats SessionStart", async () => {
    const { client, registerSession, heartbeat } = fakeClient();
    const stdout = await invoke(client, {
      session_id: config.sessionId,
      hook_event_name: "SessionStart",
      source: "startup",
    });

    expect(registerSession).toHaveBeenCalledWith({
      sessionId: config.sessionId,
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        activeDelivery: false,
        stateReporting: true,
        clientIdempotency: false,
      },
    });
    expect(heartbeat).toHaveBeenCalledWith({ sessionId: config.sessionId, state: "idle" });
    expect(stdout).toBe("");
  });

  it("does not register later events and maps PreModelRequest to busy", async () => {
    const { client, registerSession, heartbeat } = fakeClient();
    await invoke(client, {
      session_id: config.sessionId,
      hook_event_name: "PreModelRequest",
    });
    expect(registerSession).not.toHaveBeenCalled();
    expect(heartbeat).toHaveBeenCalledWith({ sessionId: config.sessionId, state: "busy" });
  });

  it("rejects another visible session before any relay mutation", async () => {
    const { client, registerSession, heartbeat } = fakeClient();
    await expect(
      invoke(client, {
        session_id: "another-thread",
        hook_event_name: "SessionStart",
        source: "startup",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(registerSession).not.toHaveBeenCalled();
    expect(heartbeat).not.toHaveBeenCalled();
  });

  it("rejects oversized input before parsing or relay activity", async () => {
    const { client, registerSession, heartbeat } = fakeClient();
    await expect(invoke(client, " ".repeat(64 * 1024 + 1))).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(registerSession).not.toHaveBeenCalled();
    expect(heartbeat).not.toHaveBeenCalled();
  });
});

describe("Codex hook CLI", () => {
  it("prints help and invokes its own dependency without protocol stdout", async () => {
    let stdout = "";
    let stderr = "";
    const io: CliIo = {
      stdout: {
        write(chunk) {
          stdout += chunk;
          return true;
        },
      },
      stderr: {
        write(chunk) {
          stderr += chunk;
          return true;
        },
      },
    };
    await expect(runMain(["codex-hook", "--help"], io)).resolves.toBe(0);
    expect(stdout).toBe("Usage: synloq codex-hook --config <path>\n");

    stdout = "";
    const runCodexHook = vi.fn().mockResolvedValue(undefined);
    await expect(
      runMain(["codex-hook", "--config", "/tmp/codex.json"], io, {
        runCodexHook,
      }),
    ).resolves.toBe(0);
    expect(runCodexHook).toHaveBeenCalledWith("/tmp/codex.json");
    expect(stdout).toBe("");
    expect(stderr).toBe("");
  });
});
