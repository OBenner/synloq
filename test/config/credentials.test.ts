import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialStore } from "../../src/config/credentials.js";
import { projectPaths } from "../../src/config/paths.js";

interface PersistedCredentials {
  version: number;
  project: string;
  entries: Array<{ agentId: string; tokenHash: string }>;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("projectPaths", () => {
  it("hashes canonical roots so equally named repositories have separate state", async () => {
    const firstParent = await mkdtemp(join(tmpdir(), "synloq-paths-a-"));
    const secondParent = await mkdtemp(join(tmpdir(), "synloq-paths-b-"));
    const firstRoot = join(firstParent, "repository");
    const secondRoot = join(secondParent, "repository");
    await Promise.all([mkdir(firstRoot), mkdir(secondRoot)]);

    const first = await projectPaths(firstRoot);
    const second = await projectPaths(secondRoot);
    const canonical = await realpath(firstRoot);
    const expectedKey = createHash("sha256").update(canonical).digest("hex").slice(0, 16);

    expect(first.key).toBe(expectedKey);
    expect(first.key).not.toBe(second.key);
    expect(first.database).not.toBe(second.database);
    expect(first.credentials).not.toBe(second.credentials);
  });
});

describe("CredentialStore", () => {
  it("issues distinct hashed tokens and authenticates only the correct project", async () => {
    const root = await mkdtemp(join(tmpdir(), "synloq-credentials-project-"));
    const home = await mkdtemp(join(tmpdir(), "synloq-credentials-home-"));
    vi.stubEnv("SYNLOQ_HOME", home);
    const store = new CredentialStore(root);

    const firstToken = await store.issue("verdicta", "cto");
    const secondToken = await store.issue("verdicta", "cto");

    expect(firstToken).not.toBe(secondToken);
    await expect(store.authenticate("verdicta", secondToken)).resolves.toEqual({
      project: "verdicta",
      agentId: "cto",
      operator: false,
    });
    await expect(store.authenticate("verdicta", "wrong-token")).rejects.toMatchObject({
      name: "SynloqError",
      code: "UNAUTHORIZED",
    });
    await expect(store.authenticate("another-project", secondToken)).rejects.toMatchObject({
      name: "SynloqError",
      code: "UNAUTHORIZED",
    });

    const paths = await projectPaths(root);
    const stored = await readFile(paths.credentials, "utf8");
    const persisted = JSON.parse(stored) as PersistedCredentials;
    expect(persisted).toMatchObject({ version: 1, project: "verdicta" });
    expect(persisted.entries).toHaveLength(2);
    expect(stored).not.toContain(firstToken);
    expect(stored).not.toContain(secondToken);
    for (const entry of persisted.entries) {
      expect(entry.agentId).toBe("cto");
      expect(entry.tokenHash).toMatch(/^[a-f0-9]{64}$/);
      expect(entry).not.toHaveProperty("token");
    }
  });

  it("reserves operator identity for the operator credential", async () => {
    const root = await mkdtemp(join(tmpdir(), "synloq-operator-project-"));
    const home = await mkdtemp(join(tmpdir(), "synloq-operator-home-"));
    vi.stubEnv("SYNLOQ_HOME", home);
    const store = new CredentialStore(root);
    const token = await store.issue("verdicta", "operator");

    await expect(store.authenticate("verdicta", token)).resolves.toEqual({
      project: "verdicta",
      agentId: "operator",
      operator: true,
    });
  });
});
