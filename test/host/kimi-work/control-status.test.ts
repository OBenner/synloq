import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  loadKimiWorkControlEndpoint,
  type KimiWorkStatusExec,
} from "../../../src/host/kimi-work/control-status.js";

const token = "test-only-token";
const status = JSON.stringify({
  control: { endpoint: { url: "ws://127.0.0.1:59262/control", auth: { token } } },
});

function windowsEnvironment(): NodeJS.ProcessEnv {
  return {
    LOCALAPPDATA: "C:\\Users\\Test\\AppData\\Local",
    APPDATA: "C:\\Users\\Test\\AppData\\Roaming",
  };
}

describe("Kimi Work local-control status", () => {
  it("uses the standard Windows installation without exposing the token", async () => {
    const exec = vi.fn<KimiWorkStatusExec>().mockResolvedValue({ stdout: status });
    const environment = windowsEnvironment();

    await expect(
      loadKimiWorkControlEndpoint({ environment, platform: "win32", exec }),
    ).resolves.toEqual({ url: "ws://127.0.0.1:59262/control", token });

    const cli = join(
      environment.APPDATA!,
      "kimi-desktop",
      "daimon-bundle",
      "app",
      "daimon",
      "dist",
      "src",
      "runner",
      "cli.js",
    );
    const config = join(
      environment.APPDATA!,
      "kimi-desktop",
      "daimon-share",
      "daimon",
      "config.json",
    );
    expect(exec).toHaveBeenCalledWith(
      join(environment.LOCALAPPDATA!, "Programs", "Kimi", "Kimi.exe"),
      [cli, "--config", config, "status", "--json"],
      expect.objectContaining({
        timeout: 5_000,
        maxBuffer: 1_048_576,
        env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: "1" }),
      }),
    );
  });

  it("accepts diagnostic fields returned by the installed host", async () => {
    const exec = vi.fn<KimiWorkStatusExec>().mockResolvedValue({
      stdout: JSON.stringify({
        control: {
          enabled: true,
          endpoint: {
            status: "stale",
            running: false,
            reason: "service_unknown",
            url: "ws://127.0.0.1:59262/control",
            host: "127.0.0.1",
            port: 59262,
            pid: 1234,
            auth: { mode: "loopback-dev-token", token },
            configPath: "C:\\Users\\Test\\config.json",
            startedAt: "2026-11-11T13:22:13.003Z",
            updatedAt: "2026-11-11T13:22:13.003Z",
          },
        },
      }),
    });

    await expect(
      loadKimiWorkControlEndpoint({
        environment: windowsEnvironment(),
        platform: "win32",
        exec,
      }),
    ).resolves.toEqual({ url: "ws://127.0.0.1:59262/control", token });
  });

  it("honors executable, CLI, and config environment overrides", async () => {
    const exec = vi.fn<KimiWorkStatusExec>().mockResolvedValue({ stdout: status });
    const environment = {
      ...windowsEnvironment(),
      KIMI_WORK_EXECUTABLE: "D:\\Custom\\Kimi.exe",
      KIMI_WORK_CLI: "D:\\Custom\\cli.js",
      KIMI_WORK_CONFIG: "D:\\Custom\\config.json",
    };

    await loadKimiWorkControlEndpoint({ environment, platform: "win32", exec });

    expect(exec).toHaveBeenCalledWith(
      "D:\\Custom\\Kimi.exe",
      ["D:\\Custom\\cli.js", "--config", "D:\\Custom\\config.json", "status", "--json"],
      expect.anything(),
    );
  });

  it("uses kimi-daimon from PATH on non-Windows hosts", async () => {
    const exec = vi.fn<KimiWorkStatusExec>().mockResolvedValue({ stdout: status });

    await loadKimiWorkControlEndpoint({
      environment: { HOME: "/home/test", KIMI_WORK_CONFIG: "/tmp/kimi.json" },
      platform: "linux",
      exec,
    });

    expect(exec).toHaveBeenCalledWith(
      "kimi-daimon",
      ["--config", "/tmp/kimi.json", "status", "--json"],
      expect.objectContaining({
        env: expect.not.objectContaining({ ELECTRON_RUN_AS_NODE: "1" }),
      }),
    );
  });

  it.each([
    "ws://example.com/control",
    "http://127.0.0.1/control",
    "ws://user:secret@127.0.0.1/control",
  ])("rejects a non-loopback or credentialed endpoint %s", async (url) => {
    const exec = vi.fn<KimiWorkStatusExec>().mockResolvedValue({
      stdout: JSON.stringify({ control: { endpoint: { url, auth: { token } } } }),
    });

    await expect(
      loadKimiWorkControlEndpoint({
        environment: windowsEnvironment(),
        platform: "win32",
        exec,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects an empty token without including endpoint credentials in diagnostics", async () => {
    const exec = vi.fn<KimiWorkStatusExec>().mockResolvedValue({
      stdout: JSON.stringify({
        control: { endpoint: { url: "ws://127.0.0.1/control", auth: { token: "" } } },
      }),
    });

    const error = await loadKimiWorkControlEndpoint({
      environment: windowsEnvironment(),
      platform: "win32",
      exec,
    }).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "NOT_FOUND" });
    expect((error as Error).message).not.toContain(token);
  });

  it("sanitizes process failures and malformed status output", async () => {
    const failure = vi.fn<KimiWorkStatusExec>().mockRejectedValue(new Error(`failed ${token}`));
    const malformed = vi.fn<KimiWorkStatusExec>().mockResolvedValue({ stdout: "not-json" });

    for (const exec of [failure, malformed]) {
      const error = await loadKimiWorkControlEndpoint({
        environment: windowsEnvironment(),
        platform: "win32",
        exec,
      }).catch((reason: unknown) => reason);
      expect(error).toMatchObject({
        code: "NOT_FOUND",
        message: "Kimi Work local-control status is unavailable",
      });
      expect((error as Error).message).not.toContain(token);
    }
  });
});
