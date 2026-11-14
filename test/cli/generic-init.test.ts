import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runMain } from "../../src/cli/main.js";
import type {
  InitializeTeamOptions,
  InitializeTeamResult,
  KimiWorkInitHost,
} from "../../src/init/initialize-team.js";

function result(root: string, options: InitializeTeamOptions): InitializeTeamResult {
  return {
    project: options.project,
    manifestPath: join(root, "synloq.yaml"),
    statePath: join(options.synloqHome ?? root, "state.json"),
    pluginSourcePath: options.pluginSourcePath,
    registrationRequired: true,
    pluginVersion: "0.1.0+local.test.000000000000",
    channelsChanged: false,
    nextStep: "Press Install/Update in Kimi Work to install the generated plugin.",
    roles: options.roles.map((role) => ({
      agentId: role.agentId,
      conversationKey: `created-${role.agentId}`,
      configPath: join(root, `${role.agentId}.json`),
      credentialPath: join(root, `${role.agentId}.token`),
    })),
  };
}

describe("generic synloq init CLI", () => {
  it("passes arbitrary non-interactive roles to the shared engine without printing tokens", async () => {
    const root = await mkdtemp(join(tmpdir(), "synloq-generic-cli-"));
    const home = await mkdtemp(join(tmpdir(), "synloq-generic-home-"));
    const pluginSource = join(home, "plugin");
    const secretToken = "never-print-this-token";
    const initialize = vi.fn(async (options: InitializeTeamOptions) => {
      expect(JSON.stringify(options)).not.toContain(secretToken);
      return result(root, options);
    });
    const host: KimiWorkInitHost = {
      create: vi.fn(),
      list: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    let stdout = "";
    let stderr = "";

    const exitCode = await runMain(
      [
        "init",
        "--project-root",
        root,
        "--project",
        "example",
        "--role",
        "product:Product:Own scope and priorities",
        "--role",
        "reviewer:Reviewer:Review evidence and risks",
        "--role-instructions",
        "reviewer:Keep findings bounded",
        "--plugin-source",
        pluginSource,
        "--synloq-home",
        home,
        "--non-interactive",
      ],
      {
        stdout: { write: (chunk) => ((stdout += String(chunk)), true) },
        stderr: { write: (chunk) => ((stderr += String(chunk)), true) },
      },
      { initialize, initHost: async () => host },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).not.toContain(secretToken);
    expect(JSON.parse(stdout).roles).toHaveLength(2);
    expect(initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot: root,
        project: "example",
        synloqHome: home,
        pluginSourcePath: pluginSource,
        host,
        roles: [
          { agentId: "product", title: "Product", role: "Own scope and priorities" },
          {
            agentId: "reviewer",
            title: "Reviewer",
            role: "Review evidence and risks",
            instructions: "Keep findings bounded",
          },
        ],
      }),
    );
    expect(host.close).toHaveBeenCalledTimes(1);
  });

  it("uses the wizard and directory basename when no manifest or roles exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "synloq-wizard-project-"));
    const home = await mkdtemp(join(tmpdir(), "synloq-wizard-home-"));
    const initialize = vi.fn(async (options: InitializeTeamOptions) => result(root, options));
    const host: KimiWorkInitHost = { create: vi.fn(), list: vi.fn(), close: vi.fn() };

    const exitCode = await runMain(
      ["init", "--project-root", root, "--plugin-source", join(home, "plugin")],
      { stdout: { write: () => true }, stderr: { write: () => true } },
      {
        initialize,
        initHost: async () => host,
        initWizard: async () => ({
          project: basename(root),
          roles: [{ agentId: "owner", title: "Owner", role: "Own delivery" }],
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        project: basename(root),
        roles: [{ agentId: "owner", title: "Owner", role: "Own delivery" }],
      }),
    );
  });

  it("rejects missing roles in non-interactive mode before creating a host", async () => {
    const root = await mkdtemp(join(tmpdir(), "synloq-empty-init-"));
    const initHost = vi.fn();
    const exitCode = await runMain(
      ["init", "--project-root", root, "--non-interactive"],
      { stdout: { write: () => true }, stderr: { write: () => true } },
      { initHost },
    );

    expect(exitCode).toBe(1);
    expect(initHost).not.toHaveBeenCalled();
  });
});
