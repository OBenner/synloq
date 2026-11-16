import { mkdtemp, readFile, writeFile, unlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, it } from "vitest";
import { reconcileTeam } from "../../src/init/reconcile.js";
import { doctorCommand, removeRoleCommand } from "../../src/cli/commands.js";
import { projectPaths } from "../../src/config/paths.js";
import { TeamStateStore } from "../../src/config/team-state.js";
import { CredentialStore } from "../../src/config/credentials.js";
import { auditLogPath, readAuditTail } from "../../src/relay/audit-log.js";

it("audits Desktop credential issuance in doctor without duplicate events on re-init", async () => {
  const root = await mkdtemp(join(tmpdir(), "synloq-desktop-audit-"));
  const home = join(root, "home");
  try {
    const options = {
      projectRoot: root,
      project: "desktop",
      synloqHome: home,
      relayUrl: "http://127.0.0.1:4399",
      runtimeEntrypoint: "dist/mcp/stdio.js",
      roles: [
        { agentId: "arch", title: "Architect", role: "Review", host: "codex-desktop" as const },
      ],
    };
    const unavailable = async (): Promise<never> => {
      throw new Error("host API must not be called");
    };
    const deps = { kimiWorkHost: unavailable, openCodeHost: unavailable };
    await reconcileTeam(options, deps);
    const paths = await projectPaths(root, home);
    const path = auditLogPath(paths.home, paths.key);
    const issued = await readAuditTail(path, 20);
    expect(
      issued.map(({ action, agentId, reasonCode }) => ({ action, agentId, reasonCode })),
    ).toEqual([
      { action: "issue", agentId: "operator", reasonCode: "ISSUED" },
      { action: "issue", agentId: "arch", reasonCode: "ISSUED" },
    ]);
    const first = await readFile(path, "utf8");
    await reconcileTeam(options, deps);
    expect(await readFile(path, "utf8")).toBe(first);
    const doctor = await doctorCommand({ projectRoot: root, synloqHome: home });
    expect(doctor.audit?.entries).toEqual(issued);
    for (const agentId of ["operator", "arch"]) {
      const token = (await readFile(join(paths.tokens, `${agentId}.token`), "utf8")).trim();
      expect(first).not.toContain(token);
    }
    expect(first).not.toContain("tokenHash");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("provisions isolated Desktop configs, reuses credentials, diagnoses drift and removes only generated files", async () => {
  const root = await mkdtemp(join(tmpdir(), "synloq-desktop-"));
  const home = join(root, "home");
  const options = {
    projectRoot: root,
    project: "desktop",
    synloqHome: home,
    relayUrl: "http://127.0.0.1:4399",
    runtimeEntrypoint: "dist/mcp/stdio.js",
    roles: ["cto", "arch"].map((agentId) => ({
      agentId,
      title: agentId,
      role: "Review",
      host: "codex-desktop" as const,
    })),
  };
  const unavailable = async (): Promise<never> => {
    throw new Error("host API must not be called");
  };
  const deps = { kimiWorkHost: unavailable, openCodeHost: unavailable };
  const first = await reconcileTeam(options, deps);
  expect(first.manual.roles).toEqual([]);
  const role = first.desktop.roles[0]!;
  const tomlPath = join(role.directory, ".codex", "config.toml");
  const toml = await readFile(tomlPath, "utf8");
  expect(toml).toContain("[mcp_servers.synloq-cto]");
  expect(toml).not.toContain("synloq-arch");
  expect(await readFile(join(role.directory, "AGENTS.md"), "utf8")).toContain("reactive");
  const config = JSON.parse(await readFile(role.configPath, "utf8"));
  const token = (
    await readFile(resolve(dirname(role.configPath), config.credentialPath), "utf8")
  ).trim();
  expect(await new CredentialStore(root, home).authenticate("desktop", token)).toMatchObject({
    agentId: "cto",
  });
  await reconcileTeam(options, deps);
  expect(await readFile(tomlPath, "utf8")).toBe(toml);
  expect((await readFile(role.credentialPath, "utf8")).trim()).toBe(token);
  const paths = await projectPaths(root, home);
  const state = await new TeamStateStore(paths.bindings).read();
  expect(state?.claims?.cto).toBeUndefined();
  expect(state?.placements?.cto?.instructions).toBeUndefined();
  await unlink(tomlPath);
  expect(
    (await doctorCommand({ projectRoot: root, synloqHome: home })).participants[0]?.placement?.ok,
  ).toBe(false);
  await reconcileTeam(options, deps);
  expect(await readFile(tomlPath, "utf8")).toBe(toml);
  await writeFile(tomlPath, `${toml}\n# changed\n`);
  expect(
    (await doctorCommand({ projectRoot: root, synloqHome: home })).participants[0]?.placement?.ok,
  ).toBe(false);
  await expect(reconcileTeam(options, deps)).rejects.toThrow("refusing to overwrite");
  await writeFile(tomlPath, toml);
  await writeFile(join(role.directory, "user-notes.txt"), "Keep this");
  await removeRoleCommand({
    projectRoot: root,
    synloqHome: home,
    agentId: "cto",
    operatorCredentialPath: join(paths.tokens, "operator.token"),
  });
  await expect(readFile(tomlPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(role.directory, "user-notes.txt"), "utf8")).toBe("Keep this");
  expect((await new TeamStateStore(paths.bindings).read())?.placements?.cto).toBeUndefined();
});
