import { mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { doctorCommand } from "../../src/cli/commands.js";
import { loadManifest, loadManifestRoles } from "../../src/config/manifest.js";
import { projectPaths } from "../../src/config/paths.js";
import { TeamStateStore } from "../../src/config/team-state.js";
import type {
  KimiWorkConversationSummary,
  KimiWorkCreateInput,
} from "../../src/host/kimi-work/control-client.js";
import { reconcileTeam } from "../../src/init/reconcile.js";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "synloq-mixed-")));
  const home = join(root, "home");
  const conversations: KimiWorkConversationSummary[] = [];
  const kimi = {
    create: vi.fn(async (input: KimiWorkCreateInput) => {
      const conversation = {
        ...input,
        title: "CTO",
        conversationKey: "kimi-cto",
        conversationId: "cto",
      };
      conversations.push(conversation);
      return conversation;
    }),
    list: vi.fn(async () => ({ conversations, page: { limit: 100, hasMore: false } })),
    close: vi.fn(async () => {}),
  };
  const opencode = {
    getSession: vi.fn(async () => true),
    createSession: vi.fn(async () => ({ id: "oc-dev", permissionsApplied: true })),
    postPrompt: vi.fn(async () => {}),
    deleteSession: vi.fn(async () => true),
  };
  return {
    root,
    home,
    kimi,
    opencode,
    options: {
      projectRoot: root,
      project: "mixed",
      synloqHome: home,
      pluginSourcePath: join(home, "plugin"),
      runtimeEntrypoint: "dist/mcp/stdio.js",
      relayUrl: "http://127.0.0.1:4399",
      roles: [
        { agentId: "cto", title: "CTO", role: "Coordinate", host: "kimi-work" as const },
        { agentId: "dev", title: "Dev", role: "Implement", host: "opencode" as const },
        { agentId: "arch", title: "Arch", role: "Design", host: "codex-desktop" as const },
        { agentId: "qa", title: "QA", role: "Verify", host: "zcode" as const },
      ],
    },
  };
}

describe("mixed-host reconcile", () => {
  it("defaults an omitted host to Kimi Work and resumes after another host fails", async () => {
    const { kimi, opencode, options } = await fixture();
    const roles = options.roles.map((role) =>
      role.agentId === "cto" ? { agentId: role.agentId, title: role.title, role: role.role } : role,
    );
    const openCodeHost = vi
      .fn()
      .mockRejectedValueOnce(new Error("host unavailable"))
      .mockResolvedValue(opencode);
    const dependencies = { kimiWorkHost: async () => kimi, openCodeHost };
    await expect(reconcileTeam({ ...options, roles }, dependencies)).rejects.toThrow(
      "host unavailable",
    );
    const result = await reconcileTeam({ ...options, roles }, dependencies);
    expect(result.roles[0]).toMatchObject({ host: "kimi-work", canProvisionSessions: true });
    expect(kimi.create).toHaveBeenCalledTimes(1);
    expect(opencode.createSession).toHaveBeenCalledTimes(1);
  });

  it("provisions each host, preserves the full manifest, and reports manual steps and host consistency", async () => {
    const { root, home, kimi, opencode, options } = await fixture();
    const dependencies = { kimiWorkHost: async () => kimi, openCodeHost: async () => opencode };
    const first = await reconcileTeam(options, dependencies);
    const roles = await loadManifestRoles(root);
    expect(roles.map((role) => role.host)).toEqual(options.roles.map((role) => role.host));
    // Host placement must never leak into the relay participant representation.
    expect((await loadManifest(root)).every((role) => !("host" in role))).toBe(true);
    expect(first.manual.roles.map((role) => role.agentId)).toEqual(["qa"]);
    expect(first.desktop.roles.map((role) => role.agentId)).toEqual(["arch"]);
    expect(first.manual.nextSteps.join(" ")).toContain("claim");
    const paths = await projectPaths(root, home);
    const before = await readFile(paths.bindings, "utf8");
    await reconcileTeam(options, dependencies);
    expect(kimi.create).toHaveBeenCalledTimes(1);
    expect(opencode.createSession).toHaveBeenCalledTimes(1);
    expect(kimi.close).toHaveBeenCalledTimes(2);
    expect(JSON.parse(before).conversations).toEqual(
      (await new TeamStateStore(paths.bindings).read())!.conversations,
    );
    const doctor = await doctorCommand({ projectRoot: root, synloqHome: home });
    expect(doctor.participants.map((p) => p.host)).toEqual(options.roles.map((role) => role.host));
    expect(doctor.participants.every((p) => p.placement?.ok)).toBe(true);
    expect(doctor.participants.find((p) => p.agentId === "arch")?.placement?.state).toBe(
      "configured",
    );
    const config = JSON.parse(await readFile(join(paths.runtime, "mcp", "cto.json"), "utf8"));
    expect(config.relayUrl).toBe(options.relayUrl);
    for (const role of [first.kimi!.roles[0]!, first.opencode!.roles[0]!, first.manual.roles[0]!]) {
      const runtime = JSON.parse(await readFile(role.configPath, "utf8"));
      expect(runtime.credentialPath).toBe(
        `../../../credentials/${paths.key}/${role.agentId}.token`,
      );
      expect(resolve(dirname(role.configPath), runtime.credentialPath)).toBe(role.credentialPath);
    }
  });

  it("reports placement and OpenCode hostCheck together, with host probes only on request", async () => {
    const { root, home, kimi, opencode, options } = await fixture();
    await reconcileTeam(options, {
      kimiWorkHost: async () => kimi,
      openCodeHost: async () => opencode,
    });
    opencode.getSession.mockClear();
    const offline = await doctorCommand({
      projectRoot: root,
      synloqHome: home,
      openCodeHost: opencode,
    });
    expect(opencode.getSession).not.toHaveBeenCalled();
    expect(offline.participants.find((role) => role.agentId === "dev")).toMatchObject({
      host: "opencode",
      placement: { host: "opencode", state: "bound", ok: true },
      hostCheck: { session: "unknown", opencodeConfig: "present" },
    });
    const online = await doctorCommand({
      projectRoot: root,
      synloqHome: home,
      checkHost: true,
      openCodeHost: opencode,
    });
    expect(opencode.getSession).toHaveBeenCalledExactlyOnceWith("oc-dev");
    expect(online.participants.find((role) => role.agentId === "dev")).toMatchObject({
      placement: { host: "opencode", state: "bound", ok: true },
      hostCheck: { session: "alive", opencodeConfig: "present" },
    });
  });

  it("rejects a host change before rewriting config or calling any host", async () => {
    const { root, home, kimi, opencode, options } = await fixture();
    const dependencies = { kimiWorkHost: async () => kimi, openCodeHost: async () => opencode };
    await reconcileTeam(options, dependencies);
    const manifest = await readFile(join(root, "synloq.yaml"), "utf8");
    await expect(
      reconcileTeam(
        { ...options, roles: options.roles.map((role) => ({ ...role, host: "zcode" as const })) },
        dependencies,
      ),
    ).rejects.toThrow(/replace-session/);
    expect(await readFile(join(root, "synloq.yaml"), "utf8")).toBe(manifest);
    expect(kimi.create).toHaveBeenCalledTimes(1);
    const doctor = await doctorCommand({ projectRoot: root, synloqHome: home });
    expect(doctor.participants[0]?.placement?.ok).toBe(true);
  });
});
