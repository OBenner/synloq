import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runMain } from "../../src/cli/main.js";
import type { InitializeOpenCodeTeamOptions } from "../../src/init/opencode-host.js";

describe("synloq init --host opencode", () => {
  it("routes to the OpenCode initializer without touching the Kimi host", async () => {
    const root = await mkdtemp(join(tmpdir(), "synloq-opencode-cli-"));
    const home = await mkdtemp(join(tmpdir(), "synloq-opencode-cli-home-"));
    const initializeOpenCode = vi.fn(async (options: InitializeOpenCodeTeamOptions) => ({
      project: options.project,
      manifestPath: join(options.projectRoot, "synloq.yaml"),
      statePath: join(home, "state.json"),
      opencodeConfigPath: join(options.projectRoot, "opencode.json"),
      registrationRequired: true,
      roles: options.roles.map((role) => ({
        agentId: role.agentId,
        configPath: join(home, `${role.agentId}.json`),
        credentialPath: join(home, `${role.agentId}.token`),
      })),
    }));
    const initHost = vi.fn();
    let stdout = "";
    let stderr = "";

    const exitCode = await runMain(
      [
        "init",
        "--host",
        "opencode",
        "--project-root",
        root,
        "--project",
        "stand",
        "--role",
        "cto:CTO:Coordinates the team",
        "--relay-url",
        "http://127.0.0.1:4201",
        "--synloq-home",
        home,
        "--non-interactive",
      ],
      {
        stdout: { write: (chunk) => ((stdout += String(chunk)), true) },
        stderr: { write: (chunk) => ((stderr += String(chunk)), true) },
      },
      { initializeOpenCode, initHost },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(initHost).not.toHaveBeenCalled();
    expect(initializeOpenCode).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot: root,
        project: "stand",
        synloqHome: home,
        relayUrl: "http://127.0.0.1:4201",
        roles: [{ agentId: "cto", title: "CTO", role: "Coordinates the team" }],
      }),
    );
    const printed = JSON.parse(stdout) as { opencodeConfigPath: string };
    expect(printed.opencodeConfigPath).toBe(join(root, "opencode.json"));
  });

  it("rejects an unknown host", async () => {
    let stderr = "";
    const exitCode = await runMain(
      [
        "init",
        "--host",
        "vscode",
        "--project-root",
        ".",
        "--role",
        "cto:CTO:Coordinates the team",
        "--non-interactive",
      ],
      {
        stdout: { write: () => true },
        stderr: { write: (chunk) => ((stderr += String(chunk)), true) },
      },
      { initHost: vi.fn() },
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--host must be kimi-work or opencode");
  });
});
