import { mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectPaths } from "../../src/config/paths.js";
import { TeamStateStore, type TeamState } from "../../src/config/team-state.js";
import { initializeOpenCodeTeam } from "../../src/init/opencode-host.js";

const roles = [
  { agentId: "cto", title: "CTO", role: "Coordinates the team" },
  { agentId: "arch", title: "Architect", role: "Designs the system" },
];

async function setup(): Promise<{ root: string; home: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "synloq-opencode-init-")));
  const home = await mkdtemp(join(tmpdir(), "synloq-opencode-home-"));
  return { root, home };
}

describe("initializeOpenCodeTeam", () => {
  it("creates manifest, credentials, legacy MCP configs, opencode.json, and team state", async () => {
    const { root, home } = await setup();
    const result = await initializeOpenCodeTeam({
      projectRoot: root,
      project: "stand",
      roles,
      synloqHome: home,
      runtimeEntrypoint: "dist/mcp/stdio.js",
    });

    expect(result.project).toBe("stand");
    expect(result.roles.map((role) => role.agentId)).toEqual(["cto", "arch"]);
    expect(result.registrationRequired).toBe(true);

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
    });
    await readFile(result.roles[0]!.credentialPath, "utf8");

    const opencode = JSON.parse(await readFile(join(root, "opencode.json"), "utf8")) as {
      mcp: { servers: Record<string, { type: string; command: string[]; enabled: boolean }> };
    };
    expect(Object.keys(opencode.mcp.servers).sort()).toEqual(["synloq-arch", "synloq-cto"]);
    expect(opencode.mcp.servers["synloq-cto"]).toEqual({
      type: "local",
      command: ["node", "dist/mcp/stdio.js", join(paths.runtime, "mcp", "cto.json")],
      enabled: true,
    });

    const state = await new TeamStateStore(paths.bindings).read();
    expect(state).toMatchObject({ project: "stand", projectRoot: root, conversations: {} });
  });

  it("honours a custom loopback relay URL", async () => {
    const { root, home } = await setup();
    const result = await initializeOpenCodeTeam({
      projectRoot: root,
      project: "stand",
      roles: [roles[0]!],
      synloqHome: home,
      runtimeEntrypoint: "dist/mcp/stdio.js",
      relayUrl: "http://127.0.0.1:4201",
    });
    const config = JSON.parse(await readFile(result.roles[0]!.configPath, "utf8")) as {
      relayUrl: string;
    };
    expect(config.relayUrl).toBe("http://127.0.0.1:4201");
  });

  it("re-run is a no-op: identical opencode.json, reused credentials, preserved conversations", async () => {
    const { root, home } = await setup();
    const options = {
      projectRoot: root,
      project: "stand",
      roles,
      synloqHome: home,
      runtimeEntrypoint: "dist/mcp/stdio.js",
    };
    const first = await initializeOpenCodeTeam(options);
    const paths = await projectPaths(root, home);

    const conversation = {
      agentId: "cto",
      workAgentId: "main",
      sessionKey: "agent:main:main",
      conversationKey: "existing-key",
      conversationId: "existing-id",
      workspacePath: root,
    };
    await new TeamStateStore(paths.bindings).update((state): TeamState => ({
      ...state!,
      conversations: { cto: conversation },
    }));

    const second = await initializeOpenCodeTeam(options);
    expect(await readFile(join(root, "opencode.json"), "utf8")).toBe(
      await readFile(join(root, "opencode.json"), "utf8"),
    );
    expect(second.roles[0]!.credentialPath).toBe(first.roles[0]!.credentialPath);
    expect(await readFile(second.roles[0]!.credentialPath, "utf8")).toBe(
      await readFile(first.roles[0]!.credentialPath, "utf8"),
    );
    const state = await new TeamStateStore(paths.bindings).read();
    expect(state!.conversations["cto"]).toEqual(conversation);
  });

  it("rejects --conversation bindings until sessions are supported", async () => {
    const { root, home } = await setup();
    await expect(
      initializeOpenCodeTeam({
        projectRoot: root,
        project: "stand",
        roles: [{ ...roles[0]!, conversationKey: "ses_123" }],
        synloqHome: home,
        runtimeEntrypoint: "dist/mcp/stdio.js",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects a non-loopback relay URL", async () => {
    const { root, home } = await setup();
    await expect(
      initializeOpenCodeTeam({
        projectRoot: root,
        project: "stand",
        roles,
        synloqHome: home,
        runtimeEntrypoint: "dist/mcp/stdio.js",
        relayUrl: "http://203.0.113.10:4100",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects duplicate role IDs and foreign team state", async () => {
    const { root, home } = await setup();
    await expect(
      initializeOpenCodeTeam({
        projectRoot: root,
        project: "stand",
        roles: [roles[0]!, roles[0]!],
        synloqHome: home,
        runtimeEntrypoint: "dist/mcp/stdio.js",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    await initializeOpenCodeTeam({
      projectRoot: root,
      project: "stand",
      roles,
      synloqHome: home,
      runtimeEntrypoint: "dist/mcp/stdio.js",
    });
    await expect(
      initializeOpenCodeTeam({
        projectRoot: root,
        project: "other",
        roles,
        synloqHome: home,
        runtimeEntrypoint: "dist/mcp/stdio.js",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
