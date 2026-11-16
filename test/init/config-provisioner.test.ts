import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { doctorCommand, removeRoleCommand, claimCommand } from "../../src/cli/commands.js";
import { projectPaths } from "../../src/config/paths.js";
import { TeamStateStore } from "../../src/config/team-state.js";
import {
  writeManifest,
  loadManifestRoles,
  manifestUnknownFields,
} from "../../src/config/manifest.js";
import { CONFIG_PROVISIONERS } from "../../src/init/config-provisioners.js";
import { digest } from "../../src/init/codex-desktop.js";
import { reconcileTeam } from "../../src/init/reconcile.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "synloq-config-provisioner-"));
  roots.push(root);
  const projectRoot = join(root, "project");
  await mkdir(projectRoot);
  const options = {
    projectRoot,
    synloqHome: join(root, "home"),
    project: "test",
    relayUrl: "http://127.0.0.1:4399",
    runtimeEntrypoint: "dist/mcp/stdio.js",
    roles: [
      {
        agentId: "arch",
        title: "Arch",
        role: "Design",
        host: "codex-desktop" as const,
        placement: "roles/arch",
      },
      { agentId: "dev", title: "Dev", role: "Implement", host: "codex-desktop" as const },
    ],
  };
  const unavailable = async (): Promise<never> => {
    throw new Error("host must not be called");
  };
  return { root, options, deps: { kimiWorkHost: unavailable, openCodeHost: unavailable } };
}

describe("config provisioner registry and placement", () => {
  it("accepts legacy full-file hashes after a host appends foreign settings", async () => {
    const { options, deps } = await fixture();
    const result = await reconcileTeam(options, deps);
    const path = join(result.desktop.roles[0]!.directory, ".codex", "config.toml");
    const original = await readFile(path, "utf8");
    const paths = await projectPaths(options.projectRoot, options.synloqHome);
    const store = new TeamStateStore(paths.bindings);
    await store.update((state) => ({
      ...state!,
      placements: {
        ...state!.placements,
        arch: {
          ...state!.placements!.arch!,
          desktopFiles: {
            ...state!.placements!.arch!.desktopFiles,
            ".codex/config.toml": digest(original),
          },
        },
      },
    }));
    await writeFile(path, original + '\n[projects.example]\ntrust_level = "trusted"\n');
    expect(
      (await doctorCommand(options)).participants.find((p) => p.agentId === "arch")?.placement?.ok,
    ).toBe(true);
    await reconcileTeam(options, deps);
    expect(await readFile(path, "utf8")).toContain("trust_level");
  });
  it("dispatches provision, inspect, and remove through the registry; preserves host changes", async () => {
    const { options, deps } = await fixture();
    const actual = CONFIG_PROVISIONERS["codex-desktop"]!;
    const provisioner = {
      provision: vi.fn(actual.provision),
      inspect: vi.fn(actual.inspect),
      remove: vi.fn(actual.remove),
    };
    const configProvisioners = { "codex-desktop": provisioner };
    const first = await reconcileTeam(options, { ...deps, configProvisioners });
    expect(provisioner.provision).toHaveBeenCalledTimes(1);
    const directory = join(options.projectRoot, "roles", "arch");
    expect(first.desktop.roles[0]?.directory).toBe(directory);
    expect(
      (await loadManifestRoles(options.projectRoot)).find((role) => role.agentId === "arch")
        ?.placement,
    ).toBe("roles/arch");
    expect(await manifestUnknownFields(options.projectRoot)).toEqual([]);
    const paths = await projectPaths(options.projectRoot, options.synloqHome);
    const config = join(directory, ".codex", "config.toml");
    const original = await readFile(config, "utf8");
    const foreign = '\n[projects."example"]\ntrust_level = "trusted"\n';
    await writeFile(config, original + foreign);
    expect(
      (await doctorCommand({ ...options, configProvisioners })).participants.find(
        (p) => p.agentId === "arch",
      )?.placement?.ok,
    ).toBe(true);
    await reconcileTeam(options, { ...deps, configProvisioners });
    expect(await readFile(config, "utf8")).toBe(original + foreign);
    expect(provisioner.inspect).toHaveBeenCalled();
    // Doctor/remove follow the saved location, even if desired placement changed.
    await writeManifest(
      options.projectRoot,
      options.roles.map((role) => ({ ...role, project: options.project, placement: "elsewhere" })),
    );
    expect(
      (await doctorCommand({ ...options, configProvisioners })).participants.find(
        (p) => p.agentId === "arch",
      )?.placement?.ok,
    ).toBe(true);
    await removeRoleCommand({
      ...options,
      configProvisioners,
      agentId: "arch",
      operatorCredentialPath: join(paths.tokens, "operator.token"),
    });
    expect(provisioner.remove).toHaveBeenCalledTimes(1);
    expect(await readFile(config, "utf8")).toBe("\n" + foreign);
    await expect(readFile(join(directory, "AGENTS.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects placement moves, collisions, and unsafe roots before provisioning", async () => {
    const { options, deps } = await fixture();
    await reconcileTeam(options, deps);
    await expect(
      reconcileTeam(
        { ...options, roles: [{ ...options.roles[0]!, placement: "new-place" }] },
        deps,
      ),
    ).rejects.toThrow("placement changed");
    await expect(
      reconcileTeam({ ...options, roles: [{ ...options.roles[0]!, agentId: "other" }] }, deps),
    ).rejects.toThrow("overlaps");
    for (const placement of [
      options.projectRoot,
      options.synloqHome,
      join(options.synloqHome, "credentials"),
      dirname(options.projectRoot),
    ]) {
      await expect(
        reconcileTeam(
          { ...options, roles: [{ ...options.roles[0]!, agentId: "other", placement }] },
          deps,
        ),
      ).rejects.toThrow("placement must not");
    }
    const paths = await projectPaths(options.projectRoot, options.synloqHome);
    expect((await new TeamStateStore(paths.bindings).read())?.placements?.arch?.directory).toBe(
      join(options.projectRoot, "roles", "arch"),
    );
  });

  it("detects changes to its table and AGENTS, retaining modified files on removal", async () => {
    const { options, deps } = await fixture();
    const result = await reconcileTeam(options, deps);
    const directory = result.desktop.roles[0]!.directory;
    const path = join(directory, ".codex/config.toml");
    const original = await readFile(path, "utf8");
    const modified = original.replace('command = "node"', 'command = "different"');
    await writeFile(path, modified);
    expect(
      (await doctorCommand(options)).participants.find((p) => p.agentId === "arch")?.placement?.ok,
    ).toBe(false);
    await expect(reconcileTeam(options, deps)).rejects.toThrow("modified role table");
    await writeFile(path, original);
    const agents = join(directory, "AGENTS.md");
    await writeFile(agents, (await readFile(agents, "utf8")) + "\nUser change\n");
    await expect(reconcileTeam(options, deps)).rejects.toThrow("refusing to overwrite");
    const paths = await projectPaths(options.projectRoot, options.synloqHome);
    const removed = await removeRoleCommand({
      ...options,
      agentId: "arch",
      operatorCredentialPath: join(paths.tokens, "operator.token"),
    });
    expect(removed.nextSteps.join(" ")).toContain("retained");
    expect(await readFile(agents, "utf8")).toContain("User change");
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it("refuses redirected placement parents", async () => {
    const { root, options, deps } = await fixture();
    const external = join(root, "external");
    await mkdir(external);
    await symlink(
      external,
      join(options.projectRoot, "redirect"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(
      reconcileTeam(
        { ...options, roles: [{ ...options.roles[0]!, placement: "redirect/arch" }] },
        deps,
      ),
    ).rejects.toThrow("symlink");
    await expect(readFile(join(external, "arch", "AGENTS.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("flips claimed manual placement to bound and does not undo it on re-init", async () => {
    const { options, deps } = await fixture();
    const manual = {
      ...options,
      roles: [{ agentId: "arch", title: "Arch", role: "Design", host: "generic" as const }],
    };
    const first = await reconcileTeam(manual, deps);
    await claimCommand({ ...options, code: first.manual.roles[0]!.claimCode });
    const paths = await projectPaths(options.projectRoot, options.synloqHome);
    expect((await new TeamStateStore(paths.bindings).read())?.placements?.arch?.state).toBe(
      "bound",
    );
    expect((await doctorCommand(options)).participants[0]?.placement?.state).toBe("bound");
    const second = await reconcileTeam(manual, deps);
    expect(second.manual.roles[0]?.claimCode).toBe("");
    expect((await new TeamStateStore(paths.bindings).read())?.claims?.arch).toBeUndefined();
    expect((await new TeamStateStore(paths.bindings).read())?.placements?.arch?.state).toBe(
      "bound",
    );
  });
});
