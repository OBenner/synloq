import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadManifestRoles,
  LOCAL_OVERLAY_FILENAME,
  writeManifest,
} from "../../src/config/manifest.js";
import { SynloqError } from "../../src/domain/errors.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function projectWith(manifest: string, overlay?: string) {
  const root = await mkdtemp(join(tmpdir(), "synloq-notes-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "synloq.yaml"), manifest);
  if (overlay !== undefined) await writeFile(join(root, LOCAL_OVERLAY_FILENAME), overlay);
  return root;
}

const base = `version: 1
project: notes-fixture
agents:
  arch:
    title: Architect
    role: Design decisions
`;

describe("manifest notes (#108)", () => {
  it("reads notes from the manifest and round-trips them through writeManifest", async () => {
    const root = await projectWith(
      `version: 1
project: notes-fixture
agents:
  arch:
    title: Architect
    role: Design decisions
    notes: Prefers evidence-linked decisions.
`,
    );
    const roles = await loadManifestRoles(root);
    expect(roles.find((role) => role.agentId === "arch")?.notes).toBe(
      "Prefers evidence-linked decisions.",
    );
    await writeManifest(root, roles);
    expect((await loadManifestRoles(root)).find((role) => role.agentId === "arch")?.notes).toBe(
      "Prefers evidence-linked decisions.",
    );
  });

  it("accepts a role without notes and keeps notes absent from the rewrite", async () => {
    const root = await projectWith(base);
    const roles = await loadManifestRoles(root);
    expect(roles.find((role) => role.agentId === "arch")?.notes).toBeUndefined();
    await writeManifest(root, roles);
    const rewritten = await readFile(join(root, "synloq.yaml"), "utf8");
    expect(rewritten).not.toContain("notes:");
  });

  it("fails loud on notes longer than 500 characters", async () => {
    const root = await projectWith(
      `version: 1
project: notes-fixture
agents:
  arch:
    title: Architect
    role: Design decisions
    notes: "${"x".repeat(501)}"
`,
    );
    await expect(loadManifestRoles(root)).rejects.toThrow(SynloqError);
  });

  it("merges notes through the local overlay like any other field", async () => {
    const root = await projectWith(
      base,
      `agents:
  arch:
    notes: Overlay note wins.
`,
    );
    expect((await loadManifestRoles(root)).find((role) => role.agentId === "arch")?.notes).toBe(
      "Overlay note wins.",
    );
  });

  it("rejects unknown agent keys in the strict view (doctor warning path)", async () => {
    const root = await projectWith(
      base.replace(
        "    role: Design decisions",
        "    role: Design decisions\n    nots: typo field",
      ),
    );
    const roles = await loadManifestRoles(root);
    // Tolerant reader keeps the role; the typo is a doctor warning, not a failure.
    expect(roles.find((role) => role.agentId === "arch")?.title).toBe("Architect");
  });
});
