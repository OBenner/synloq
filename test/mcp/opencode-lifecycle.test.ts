import { afterEach, describe, expect, it, vi } from "vitest";
import { SynloqError } from "../../src/domain/errors.js";
import {
  createOpenCodeLifecycle,
  type OpenCodeFactoryOptions,
  type OpenCodeMcpBridge,
} from "../../src/mcp/opencode-lifecycle.js";
import { RelayHttpClient } from "../../src/transport/http-client.js";

const relay = new RelayHttpClient("http://127.0.0.1:4100", () => "test-token");
const binding = { workspacePath: "/test", agentId: "arch", sessionId: "ses_arch" };
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  vi.useRealTimers();
});

function bridge() {
  return {
    runner: { start: vi.fn(), close: vi.fn(async () => undefined) },
    adapter: { close: vi.fn(async () => undefined), ping: vi.fn(async () => true) },
  };
}

function fixture(factory: (options: OpenCodeFactoryOptions) => Promise<OpenCodeMcpBridge>) {
  const lines: string[] = [];
  const lifecycle = createOpenCodeLifecycle(binding, relay, "test-token", {
    openCodeFactory: factory,
    openCodeStartupAttempts: 3,
    openCodeRetryDelayMs: 10,
    stderr: { write: (text) => lines.push(text) },
  });
  closers.push(() => lifecycle.close());
  return { lifecycle, lines };
}

describe("OpenCode MCP lifecycle", () => {
  it("does not poll before registration resolves and closes once", async () => {
    const value = bridge();
    let registered!: (value: OpenCodeMcpBridge) => void;
    const factory = vi.fn(
      () =>
        new Promise<OpenCodeMcpBridge>((resolve) => {
          registered = resolve;
        }),
    );
    const { lifecycle } = fixture(factory);
    lifecycle.start();
    lifecycle.start();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(value.runner.start).not.toHaveBeenCalled();
    registered(value);
    await vi.waitFor(() => expect(value.runner.start).toHaveBeenCalledTimes(1));
    lifecycle.start();
    expect(factory).toHaveBeenCalledTimes(1);
    await Promise.all([lifecycle.close(), lifecycle.close()]);
    expect(value.runner.close).toHaveBeenCalledTimes(1);
    expect(value.adapter.close).toHaveBeenCalledTimes(1);
  });

  it.each(["DUPLICATE_SESSION", "NOT_WRITER", "UNAUTHORIZED"] as const)(
    "fails closed without retry on %s",
    async (code) => {
      const factory = vi.fn(async () => {
        throw new SynloqError(code, "test-token service-secret");
      });
      const { lifecycle, lines } = fixture(factory);
      lifecycle.start();
      await vi.waitFor(() => expect(lines.join("")).toContain("MCP tools remain available"));
      lifecycle.start();
      expect(factory).toHaveBeenCalledTimes(1);
      expect(await lifecycle.ping("ping")).toBe(false);
      expect(lines.join("")).not.toContain("test-token");
      expect(lines.join("")).not.toContain("service-secret");
    },
  );

  it("retries transient startup with bounded exponential backoff", async () => {
    vi.useFakeTimers();
    const factory = vi.fn(async () => {
      throw new Error("host unavailable");
    });
    const { lifecycle, lines } = fixture(factory);
    lifecycle.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(factory).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(factory).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(19);
    expect(factory).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(factory).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(factory).toHaveBeenCalledTimes(3);
    expect(lines.join("")).toContain("bounded startup retries");
  });

  it("retains the outstanding tracker between transient startup attempts", async () => {
    const seen: OpenCodeFactoryOptions[] = [];
    const value = bridge();
    const { lifecycle } = fixture(async (options) => {
      seen.push(options);
      if (seen.length === 1) throw new Error("temporarily offline");
      return value;
    });
    lifecycle.start();
    await vi.waitFor(() => expect(value.runner.start).toHaveBeenCalled());
    expect(seen).toHaveLength(2);
    expect(seen[0]!.outstanding).toBe(seen[1]!.outstanding);
  });

  it("single-flights heartbeat and runner takeover signals, never re-registering", async () => {
    const value: OpenCodeMcpBridge = bridge();
    let options!: OpenCodeFactoryOptions;
    const factory = vi.fn(async (input: OpenCodeFactoryOptions) => {
      options = input;
      return value;
    });
    const { lifecycle } = fixture(factory);
    lifecycle.start();
    await vi.waitFor(() => expect(value.runner.start).toHaveBeenCalled());
    const stale = new SynloqError("UNAUTHORIZED", "session generation is stale");
    options.onUnauthorized(stale);
    value.runner.onUnauthorized?.(stale);
    lifecycle.start();
    await lifecycle.close();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(value.runner.close).toHaveBeenCalledTimes(1);
    expect(value.adapter.close).toHaveBeenCalledTimes(1);
  });

  it("closes a late registration result after shutdown without starting the runner", async () => {
    const value = bridge();
    let resolve!: (value: OpenCodeMcpBridge) => void;
    const { lifecycle } = fixture(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    lifecycle.start();
    const closed = lifecycle.close();
    resolve(value);
    await closed;
    expect(value.runner.start).not.toHaveBeenCalled();
    expect(value.adapter.close).toHaveBeenCalledTimes(1);
  });
});
