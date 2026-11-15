import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadManifest,
  loadManifestLanguage,
  mergeManifestParticipants,
  removeManifestParticipant,
  loadManifestRoles,
  writeManifest,
} from "../../src/config/manifest.js";

async function manifestRoot(contents: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "synloq-manifest-"));
  await writeFile(join(root, "synloq.yaml"), contents);
  return root;
}

describe("loadManifest", () => {
  it("round-trips per-role hosts without exposing them on the participant API", async () => {
    const root = await mkdtemp(join(tmpdir(), "synloq-host-manifest-"));
    await writeManifest(root, [
      { project: "team", agentId: "dev", title: "Dev", role: "Build", host: "codex-desktop" },
    ]);
    expect((await loadManifestRoles(root))[0]?.host).toBe("codex-desktop");
    expect((await loadManifest(root))[0]).not.toHaveProperty("host");
  });

  it("loads role descriptions without creating instructions", async () => {
    const root = await manifestRoot(
      [
        "project: verdicta",
        "agents:",
        "  cto:",
        "    title: CTO",
        "    role: Technical strategy and architecture",
      ].join("\n"),
    );

    await expect(loadManifest(root)).resolves.toEqual([
      {
        project: "verdicta",
        agentId: "cto",
        title: "CTO",
        role: "Technical strategy and architecture",
      },
    ]);
  });

  it("writes arbitrary roles without adding instruction fields to the manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "synloq-manifest-write-"));
    await writeManifest(root, [
      {
        project: "example",
        agentId: "product",
        title: "Product",
        role: "Own scope and priorities",
      },
      {
        project: "example",
        agentId: "reviewer",
        title: "Reviewer",
        role: "Review evidence and risks",
      },
    ]);

    await expect(loadManifest(root)).resolves.toEqual([
      {
        project: "example",
        agentId: "product",
        title: "Product",
        role: "Own scope and priorities",
      },
      {
        project: "example",
        agentId: "reviewer",
        title: "Reviewer",
        role: "Review evidence and risks",
      },
    ]);
    await expect(readFile(join(root, "synloq.yaml"), "utf8")).resolves.not.toContain(
      "instructions:",
    );
  });

  it.each([
    {
      name: "an unsupported host",
      contents:
        "project: team\nagents:\n  dev:\n    title: Dev\n    role: Build\n    host: typo-host\n",
    },
    {
      name: "malformed YAML",
      contents: "project: [",
    },
    {
      name: "a missing project",
      contents: ["agents:", "  cto:", "    title: CTO", "    role: Architecture"].join("\n"),
    },
    {
      name: "an invalid agent ID",
      contents: [
        "project: verdicta",
        "agents:",
        "  CTO:",
        "    title: CTO",
        "    role: Architecture",
      ].join("\n"),
    },
    {
      name: "unknown fields",
      contents: [
        "project: verdicta",
        "instructions: Become the CTO",
        "agents:",
        "  cto:",
        "    title: CTO",
        "    role: Architecture",
      ].join("\n"),
    },
    {
      name: "an unsupported manifest version",
      contents: [
        "version: 2",
        "project: verdicta",
        "agents:",
        "  cto:",
        "    title: CTO",
        "    role: Architecture",
      ].join("\n"),
    },
  ])("rejects $name with INVALID_INPUT", async ({ contents }) => {
    const root = await manifestRoot(contents);

    await expect(loadManifest(root)).rejects.toMatchObject({
      name: "SynloqError",
      code: "INVALID_INPUT",
    });
  });
});

describe("manifest language", () => {
  it("defaults to en when the field is absent", async () => {
    const root = await manifestRoot(
      ["project: verdicta", "agents:", "  cto:", "    title: CTO", "    role: Architecture"].join(
        "\n",
      ),
    );

    await expect(loadManifestLanguage(root)).resolves.toBe("en");
  });

  it("round-trips an explicit language through writeManifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "synloq-manifest-lang-"));
    await writeManifest(
      root,
      [{ project: "example", agentId: "cto", title: "CTO", role: "Architecture" }],
      "ru",
    );

    await expect(loadManifestLanguage(root)).resolves.toBe("ru");
    await expect(readFile(join(root, "synloq.yaml"), "utf8")).resolves.toContain("language: ru");
  });

  it("rejects an unknown language fail-loud", async () => {
    const root = await manifestRoot(
      [
        "project: verdicta",
        "language: klingon",
        "agents:",
        "  cto:",
        "    title: CTO",
        "    role: Architecture",
      ].join("\n"),
    );

    await expect(loadManifest(root)).rejects.toMatchObject({
      name: "SynloqError",
      code: "INVALID_INPUT",
    });
  });
});

describe("mergeManifestParticipants / removeManifestParticipant (#32 W5)", () => {
  const cto = { project: "stand", agentId: "cto", title: "CTO", role: "Coordinates" };
  const arch = { project: "stand", agentId: "arch", title: "Architect", role: "Designs" };
  const tester = { project: "stand", agentId: "tester", title: "Tester", role: "Verifies" };

  it("preserves hosts of retained and updated roles and accepts explicit host overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "synloq-manifest-host-merge-"));
    await writeManifest(root, [
      { ...cto, host: "kimi-work" },
      { ...arch, host: "codex-desktop" },
    ]);
    const merged = await mergeManifestParticipants(root, [
      { ...arch, role: "Reviews architecture" },
      { ...tester, host: "opencode" },
    ]);
    expect(merged.map(({ agentId, host }) => ({ agentId, host }))).toEqual([
      { agentId: "cto", host: "kimi-work" },
      { agentId: "arch", host: "codex-desktop" },
      { agentId: "tester", host: "opencode" },
    ]);
    expect(await loadManifestRoles(root)).toEqual(merged);
    expect(merged.find((participant) => participant.agentId === "arch")?.role).toBe(
      "Reviews architecture",
    );
    await mergeManifestParticipants(root, [{ ...arch, host: "zcode" }]);
    expect(
      (await loadManifestRoles(root)).find((participant) => participant.agentId === "arch")?.host,
    ).toBe("zcode");
    expect((await loadManifest(root)).every((participant) => !("host" in participant))).toBe(true);
  });

  it("preserves the hosts of other roles when removing a participant", async () => {
    const root = await mkdtemp(join(tmpdir(), "synloq-manifest-host-remove-"));
    await writeManifest(root, [
      { ...cto, host: "opencode" },
      { ...arch, host: "codex-desktop" },
    ]);
    await removeManifestParticipant(root, "arch");
    expect(await loadManifestRoles(root)).toEqual([{ ...cto, host: "opencode" }]);
  });

  it("extends an existing manifest and overrides same-id roles", async () => {
    const root = await mkdtemp(join(tmpdir(), "synloq-manifest-merge-"));
    await writeManifest(root, [cto, arch]);

    const merged = await mergeManifestParticipants(root, [
      tester,
      { ...arch, role: "Designs and reviews" },
    ]);

    expect(merged.map((p) => p.agentId)).toEqual(["cto", "arch", "tester"]);
    expect(merged.find((p) => p.agentId === "arch")?.role).toBe("Designs and reviews");
    expect((await loadManifest(root)).map((p) => p.agentId)).toEqual(["cto", "arch", "tester"]);
  });

  it("writes a fresh manifest when none exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "synloq-manifest-merge-"));
    await mergeManifestParticipants(root, [cto]);
    expect((await loadManifest(root)).map((p) => p.agentId)).toEqual(["cto"]);
  });

  it("removes a role and refuses both unknown roles and emptying the manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "synloq-manifest-remove-"));
    await writeManifest(root, [cto, arch], "ru");

    await removeManifestParticipant(root, "arch");
    const remaining = await loadManifest(root);
    expect(remaining.map((p) => p.agentId)).toEqual(["cto"]);
    await expect(loadManifestLanguage(root)).resolves.toBe("ru");

    await expect(removeManifestParticipant(root, "ghost")).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(removeManifestParticipant(root, "cto")).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining("last role"),
    });
  });
});
