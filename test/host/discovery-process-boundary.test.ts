import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadKimiWorkControlEndpoint } from "../../src/host/kimi-work/control-status.js";
import { discoverOpenCodeHost } from "../../src/host/opencode/discovery.js";

// Exercise the real default wrappers down to the child_process boundary, without
// starting a host or executing the deliberately inert metacharacter fixtures.
const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile }));
beforeEach(() => {
  execFile.mockReset();
});
const status = JSON.stringify({
  control: { endpoint: { url: "ws://127.0.0.1:1234/control", auth: { token: "fixture-token" } } },
});
const info = JSON.stringify({ urls: ["http://127.0.0.1:1234/"] });
const absent = async () => {
  throw new Error("fixture missing file");
};
type Done = (error: Error | null, stdout: string, stderr: string) => void;

describe("host discovery process boundaries (#72)", () => {
  it("keeps Kimi executable, CLI and config paths as literal arguments with shell disabled", async () => {
    execFile.mockImplementation((_file: string, _args: string[], _options: unknown, done: Done) =>
      done(null, status, ""),
    );
    const environment = {
      KIMI_WORK_EXECUTABLE: "fixture/Kimi space & $(echo inert).exe",
      KIMI_WORK_CLI: "fixture/CLI space; & inert.js",
      KIMI_WORK_CONFIG: "fixture/config space; $(echo inert).json",
    };
    await expect(
      loadKimiWorkControlEndpoint({ environment, platform: "win32" }),
    ).resolves.toMatchObject({ url: "ws://127.0.0.1:1234/control" });
    expect(execFile).toHaveBeenCalledExactlyOnceWith(
      environment.KIMI_WORK_EXECUTABLE,
      [environment.KIMI_WORK_CLI, "--config", environment.KIMI_WORK_CONFIG, "status", "--json"],
      expect.objectContaining({
        shell: false,
        windowsHide: true,
        timeout: 5_000,
        maxBuffer: 1_048_576,
      }),
      expect.any(Function),
    );
  });

  it.each([
    ["win32", "where"],
    ["linux", "which"],
  ] as const)(
    "uses fixed %s locator argv and passes its path as a literal executable",
    async (platform, locator) => {
      const cli = "fixture/opencode space & $(echo inert)";
      execFile.mockImplementation((file: string, _args: string[], _options: unknown, done: Done) =>
        done(null, file === locator ? `${cli}\n` : info, ""),
      );
      await expect(
        discoverOpenCodeHost({ environment: {}, platform, readfile: absent }),
      ).resolves.toMatchObject({ cliPath: cli, source: "path" });
      expect(execFile).toHaveBeenNthCalledWith(
        1,
        locator,
        ["opencode"],
        expect.objectContaining({
          shell: false,
          timeout: 5_000,
          maxBuffer: 1_048_576,
          windowsHide: true,
        }),
        expect.any(Function),
      );
      expect(execFile).toHaveBeenNthCalledWith(
        2,
        cli,
        ["api", "get", "/api/info"],
        expect.objectContaining({
          shell: false,
          timeout: 10_000,
          maxBuffer: 1_048_576,
          windowsHide: true,
        }),
        expect.any(Function),
      );
    },
  );

  it("does not interpret an executable override as a command line", async () => {
    const executable = "fixture/opencode space; & $(echo inert)";
    execFile.mockImplementation((file: string, _args: string[], _options: unknown, done: Done) =>
      file === "which" ? done(new Error("no PATH candidate"), "", "") : done(null, info, ""),
    );
    await discoverOpenCodeHost({
      environment: { OPENCODE_EXECUTABLE: executable },
      platform: "linux",
      readfile: absent,
    });
    expect(execFile).toHaveBeenLastCalledWith(
      executable,
      ["api", "get", "/api/info"],
      expect.objectContaining({ shell: false }),
      expect.any(Function),
    );
  });

  it("does not expose child output or error details on discovery failure", async () => {
    execFile.mockImplementation((_file: string, _args: string[], _options: unknown, done: Done) =>
      done(
        new Error("fixture-secret-in-error"),
        "fixture-secret-in-stdout",
        "fixture-secret-in-stderr",
      ),
    );
    await expect(
      loadKimiWorkControlEndpoint({
        environment: { KIMI_WORK_EXECUTABLE: "fixture-kimi", KIMI_WORK_CONFIG: "fixture.json" },
        platform: "linux",
      }),
    ).rejects.toThrow("Kimi Work local-control status is unavailable");
    await expect(
      discoverOpenCodeHost({
        environment: { OPENCODE_EXECUTABLE: "fixture-opencode" },
        platform: "linux",
        readfile: absent,
      }),
    ).rejects.toThrow("OpenCode service is unavailable (is the OpenCode desktop app running?)");
  });
});
