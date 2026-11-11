import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadManifest, writeManifest } from "../../src/config/manifest.js";

async function manifestRoot(contents: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "synloq-manifest-"));
  await writeFile(join(root, "synloq.yaml"), contents);
  return root;
}

describe("loadManifest", () => {
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
