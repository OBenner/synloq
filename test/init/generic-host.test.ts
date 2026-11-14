import { mkdtemp, readFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectPaths } from "../../src/config/paths.js";
import { TeamStateStore } from "../../src/config/team-state.js";
import { initializeGenericTeam } from "../../src/init/generic-host.js";

const roles = [
  { agentId: "cto", title: "CTO", role: "Coordinates the team" },
  { agentId: "arch", title: "Architect", role: "Designs the system" },
];

async function setup(): Promise<{ root: string; home: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "synloq-generic-init-")));
  const home = await mkdtemp(join(tmpdir(), "synloq-generic-home-"));
  return { root, home };
}

describe("initializeGenericTeam", () => {
  it("creates manifest, credentials, runtime MCP configs, and team state without host bindings", async () => {
    const { root, home } = await setup();
    const result = await initializeGenericTeam({
      projectRoot: root,
      project: "stand",
      roles,
      synloqHome: home,
    });

    expect(result.project).toBe("stand");
    expect(result.roles.map((role) => role.agentId)).toEqual(["cto", "arch"]);
    expect(result.registrationRequired).toBe(false);

    const manifest = await readFile(join(root, "synloq.yaml"), "utf8");
    expect(manifest).toContain("cto");
    expect(manifest).toContain("arch");

    const paths = await projectPaths(root, home);
    const ctoConfig = JSON.parse(
      await readFile(join(paths.runtime, "mcp", "cto.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(ctoConfig).toEqual({
      relayUrl: "http://127.0.0.1:4100",
      credentialPath: result.roles[0]!.credentialPath,
      language: "en",
    });
    await readFile(result.roles[0]!.credentialPath, "utf8");

    const state = await new TeamStateStore(paths.bindings).read();
    expect(state).toMatchObject({ project: "stand", projectRoot: root, conversations: {} });
  });

  it("honours a custom loopback relay URL and rejects a remote one", async () => {
    const { root, home } = await setup();
    const result = await initializeGenericTeam({
      projectRoot: root,
      project: "stand",
      roles: [roles[0]!],
      synloqHome: home,
      relayUrl: "http://127.0.0.1:4302",
    });
    const config = JSON.parse(await readFile(result.roles[0]!.configPath, "utf8")) as {
      relayUrl: string;
    };
    expect(config.relayUrl).toBe("http://127.0.0.1:4302");

    const { root: root2, home: home2 } = await setup();
    await expect(
      initializeGenericTeam({
        projectRoot: root2,
        project: "stand",
        roles: [roles[0]!],
        synloqHome: home2,
        relayUrl: "https://relay.example.com",
      }),
    ).rejects.toThrow(/loopback/);
  });

  it("rejects conversation bindings (generic manages no host sessions)", async () => {
    const { root, home } = await setup();
    await expect(
      initializeGenericTeam({
        projectRoot: root,
        project: "stand",
        roles: [{ ...roles[0]!, conversationKey: "ses_anything" }],
        synloqHome: home,
      }),
    ).rejects.toThrow(/--conversation/);
  });

  it("is idempotent: re-run keeps credentials and config content", async () => {
    const { root, home } = await setup();
    const options = { projectRoot: root, project: "stand", roles, synloqHome: home };
    const first = await initializeGenericTeam(options);
    const tokenBefore = await stat(first.roles[0]!.credentialPath);
    const configBefore = await readFile(first.roles[0]!.configPath, "utf8");

    const second = await initializeGenericTeam(options);
    const tokenAfter = await stat(second.roles[0]!.credentialPath);
    const configAfter = await readFile(second.roles[0]!.configPath, "utf8");

    expect(second.roles[0]!.configPath).toBe(first.roles[0]!.configPath);
    expect(second.roles[0]!.credentialPath).toBe(first.roles[0]!.credentialPath);
    expect(tokenAfter.mtimeMs).toBe(tokenBefore.mtimeMs);
    expect(configAfter).toBe(configBefore);
  });

  it("fails closed when roles are already bound to host sessions", async () => {
    const { root, home } = await setup();
    const paths = await projectPaths(root, home);
    const store = new TeamStateStore(paths.bindings);
    await store.update(() => ({
      version: 1,
      project: "stand",
      projectRoot: root,
      conversations: {
        cto: {
          kind: "opencode",
          agentId: "cto",
          sessionId: "ses_bound",
          directory: root,
        },
      },
    }));

    await expect(
      initializeGenericTeam({ projectRoot: root, project: "stand", roles, synloqHome: home }),
    ).rejects.toThrow(/already bound to host sessions/);
  });
});
