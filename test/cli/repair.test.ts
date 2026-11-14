import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { doctorCommand } from "../../src/cli/commands.js";
import { repairTeamConfigs } from "../../src/cli/repair.js";
import { CredentialStore } from "../../src/config/credentials.js";
import { projectPaths } from "../../src/config/paths.js";
import { TeamStateStore } from "../../src/config/team-state.js";

const PROJECT = "verdicta";
const manifest = `project: verdicta
agents:
  cto:
    title: CTO
    role: Technical strategy
  arch:
    title: Architect
    role: Architecture review
`;

interface Fixture {
  root: string;
  home: string;
  paths: Awaited<ReturnType<typeof projectPaths>>;
  credentials: CredentialStore;
}

let fixture: Fixture;
const temporaryDirectories: string[] = [];

function kimiWorkBinding(agentId: string) {
  return {
    agentId,
    workAgentId: "main",
    sessionKey: "agent:main:main",
    conversationKey: `agent:main:main:conversation:${agentId}`,
    conversationId: crypto.randomUUID(),
    workspacePath: "",
  };
}

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "synloq-repair-project-"));
  const home = await mkdtemp(join(tmpdir(), "synloq-repair-home-"));
  temporaryDirectories.push(root, home);
  await writeFile(join(root, "synloq.yaml"), manifest, "utf8");
  vi.stubEnv("SYNLOQ_HOME", home);
  const paths = await projectPaths(root);
  const state = new TeamStateStore(paths.bindings);
  const arch = kimiWorkBinding("arch");
  const cto = kimiWorkBinding("cto");
  arch.workspacePath = root;
  cto.workspacePath = root;
  await state.write({
    version: 1,
    project: PROJECT,
    projectRoot: root,
    conversations: { arch, cto },
  });
  fixture = { root, home, paths, credentials: new CredentialStore(root) };
  await fixture.credentials.ensureCredential(PROJECT, "operator");
  await fixture.credentials.ensureCredential(PROJECT, "arch");
  await fixture.credentials.ensureCredential(PROJECT, "cto");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

function configPath(agentId: string): string {
  return join(fixture.paths.runtime, "mcp", `${agentId}.json`);
}

describe("doctor --repair (issue #6)", () => {
  it("is idempotent on a healthy setup: tokens reused, configs untouched", async () => {
    const first = await repairTeamConfigs({ projectRoot: fixture.root });
    expect(first.actions).toHaveLength(2);
    const before = await readFile(configPath("arch"), "utf8");

    const second = await repairTeamConfigs({ projectRoot: fixture.root });

    expect(second.actions).toEqual([
      { agentId: "arch", token: "reused", config: "unchanged" },
      { agentId: "cto", token: "reused", config: "unchanged" },
    ]);
    expect(await readFile(configPath("arch"), "utf8")).toBe(before);
  });

  it("recovers a revoked token: doctor flags it, --repair re-issues, doctor is green", async () => {
    await repairTeamConfigs({ projectRoot: fixture.root });
    await fixture.credentials.revoke(PROJECT, "arch");

    const flagged = await doctorCommand({ projectRoot: fixture.root });
    expect(flagged.participants.find((p) => p.agentId === "arch")?.credential?.status).toBe(
      "missing",
    );

    const repaired = await doctorCommand({ projectRoot: fixture.root, repair: true });

    expect(repaired.repair?.actions).toEqual([
      { agentId: "arch", token: "reissued", config: "unchanged" },
      { agentId: "cto", token: "reused", config: "unchanged" },
    ]);
    const arch = repaired.participants.find((p) => p.agentId === "arch");
    expect(arch?.credential?.status).toBe("ok");
    // The re-issued token really authenticates as arch again.
    const token = (await readFile(arch!.credential!.tokenPath, "utf8")).trim();
    await expect(fixture.credentials.authenticate(PROJECT, token)).resolves.toMatchObject({
      agentId: "arch",
    });
  });

  it("recovers a stale token left over from a rotation elsewhere", async () => {
    await repairTeamConfigs({ projectRoot: fixture.root });
    const tokenPath = join(fixture.paths.tokens, "cto.token");
    await writeFile(tokenPath, "stale-token-from-another-era\n", "utf8");

    const flagged = await doctorCommand({ projectRoot: fixture.root });
    expect(flagged.participants.find((p) => p.agentId === "cto")?.credential?.status).toBe("stale");

    const repaired = await doctorCommand({ projectRoot: fixture.root, repair: true });
    expect(repaired.participants.find((p) => p.agentId === "cto")?.credential?.status).toBe("ok");
  });

  it("re-renders a missing channel config from the saved team state", async () => {
    await rm(configPath("arch"), { force: true });

    const result = await repairTeamConfigs({ projectRoot: fixture.root });

    expect(result.actions.find((a) => a.agentId === "arch")?.config).toBe("written");
    const config = JSON.parse(await readFile(configPath("arch"), "utf8")) as {
      credentialPath: string;
      kimiWork: { agentId: string; conversationKey: string };
    };
    expect(config.kimiWork.agentId).toBe("arch");
    expect(config.kimiWork.conversationKey).toContain("conversation:arch");
    expect(config.credentialPath).toBe(join(fixture.paths.tokens, "arch.token"));
  });

  it("reports nothing to repair when the project was never initialized", async () => {
    const orphan = await mkdtemp(join(tmpdir(), "synloq-repair-orphan-"));
    temporaryDirectories.push(orphan);
    await writeFile(join(orphan, "synloq.yaml"), manifest, "utf8");

    const result = await repairTeamConfigs({ projectRoot: orphan });

    expect(result.actions).toEqual([]);
  });
});
