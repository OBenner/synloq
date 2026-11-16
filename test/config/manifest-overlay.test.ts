import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadManifestLanguage,
  loadManifestRetention,
  loadManifestRoles,
  LOCAL_OVERLAY_FILENAME,
} from "../../src/config/manifest.js";
import { SynloqError } from "../../src/domain/errors.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function projectWith(manifest: string, overlay?: string) {
  const root = await mkdtemp(join(tmpdir(), "synloq-overlay-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "synloq.yaml"), manifest);
  if (overlay !== undefined) await writeFile(join(root, LOCAL_OVERLAY_FILENAME), overlay);
  return root;
}

const base = `version: 1
project: overlay-fixture
language: en
retention:
  days: 7
agents:
  cto:
    title: CTO
    role: Architecture
  arch:
    title: Architect
    role: Review
    host: kimi-work
`;

describe("synloq.local.yaml overlay (issue #37)", () => {
  it("keeps committed-manifest behavior when the overlay is absent", async () => {
    const root = await projectWith(base);
    const roles = await loadManifestRoles(root);
    expect(roles.map((role) => role.agentId).sort()).toEqual(["arch", "cto"]);
    expect(roles.find((role) => role.agentId === "arch")?.host).toBe("kimi-work");
    expect(await loadManifestLanguage(root)).toBe("en");
    expect(await loadManifestRetention(root)).toEqual({ days: 7 });
  });

  it("merges per-field: overrides named fields, keeps the rest, adds roles", async () => {
    const root = await projectWith(
      base,
      `version: 1
language: ru
retention:
  days: 14
agents:
  cto:
    host: codex-desktop
  dev:
    title: Developer
    role: Implementation
    host: kimi-work
`,
    );
    const roles = await loadManifestRoles(root);
    const cto = roles.find((role) => role.agentId === "cto");
    expect(cto).toMatchObject({ title: "CTO", role: "Architecture", host: "codex-desktop" });
    expect(roles.find((role) => role.agentId === "arch")?.host).toBe("kimi-work");
    expect(roles.find((role) => role.agentId === "dev")).toMatchObject({
      title: "Developer",
      host: "kimi-work",
    });
    expect(await loadManifestLanguage(root)).toBe("ru");
    expect(await loadManifestRetention(root)).toEqual({ days: 14 });
  });

  it("fails loud on malformed YAML, naming the overlay file and line", async () => {
    const root = await projectWith(base, "agents:\n  cto: [unclosed\n");
    await expect(loadManifestRoles(root)).rejects.toThrow(SynloqError);
    await expect(loadManifestRoles(root)).rejects.toThrow(/synloq\.local\.yaml.*line \d+/);
  });

  it("refuses to override the shared project namespace", async () => {
    const root = await projectWith(base, "project: other\nagents: {}\n");
    await expect(loadManifestRoles(root)).rejects.toThrow(/must not override 'project'/);
  });

  it("refuses a new role without title and role", async () => {
    const root = await projectWith(base, "agents:\n  dev:\n    title: Developer\n");
    await expect(loadManifestRoles(root)).rejects.toThrow(/'dev' without title and role/);
  });

  it("rejects unknown overlay keys instead of ignoring them", async () => {
    const root = await projectWith(base, "agents: {}\nsurprise: true\n");
    await expect(loadManifestRoles(root)).rejects.toThrow(/overlay schema/);
  });
});
