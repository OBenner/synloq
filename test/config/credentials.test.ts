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

  it("rejects mismatched-project issuance without changing existing credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "synloq-mismatch-project-"));
    const home = await mkdtemp(join(tmpdir(), "synloq-mismatch-home-"));
    vi.stubEnv("SYNLOQ_HOME", home);
    const store = new CredentialStore(root);
    const ctoToken = await store.issue("verdicta", "cto");
    const archToken = await store.issue("verdicta", "arch");
    const paths = await projectPaths(root);
    const original = await readFile(paths.credentials, "utf8");

    await expect(store.issue("another-project", "arch")).rejects.toMatchObject({
      name: "SynloqError",
      code: "INVALID_INPUT",
    });

    await expect(readFile(paths.credentials, "utf8")).resolves.toBe(original);
    await expect(store.authenticate("verdicta", ctoToken)).resolves.toEqual({
      project: "verdicta",
      agentId: "cto",
      operator: false,
    });
    await expect(store.authenticate("verdicta", archToken)).resolves.toEqual({
      project: "verdicta",
      agentId: "arch",
      operator: false,
    });
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

describe("CredentialStore rotation and revocation", () => {
  it("rotates by replacing every stored hash and rewriting the token file", async () => {
    const root = await mkdtemp(join(tmpdir(), "synloq-rotate-project-"));
    const home = await mkdtemp(join(tmpdir(), "synloq-rotate-home-"));
    vi.stubEnv("SYNLOQ_HOME", home);
    const store = new CredentialStore(root);
    const firstToken = await store.issue("verdicta", "cto");
    const secondToken = await store.issue("verdicta", "cto");
    const archToken = await store.issue("verdicta", "arch");

    const rotated = await store.rotate("verdicta", "cto");

    expect(rotated.replacedHashes).toBe(2);
    await expect(readFile(rotated.tokenPath, "utf8")).resolves.toBe(`${rotated.token}\n`);
    for (const stale of [firstToken, secondToken]) {
      await expect(store.authenticate("verdicta", stale)).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
    }
    await expect(store.authenticate("verdicta", rotated.token)).resolves.toEqual({
      project: "verdicta",
      agentId: "cto",
      operator: false,
    });
    await expect(store.authenticate("verdicta", archToken)).resolves.toMatchObject({
      agentId: "arch",
    });

    const paths = await projectPaths(root);
    const persisted = JSON.parse(await readFile(paths.credentials, "utf8")) as {
      entries: Array<{ agentId: string }>;
    };
    expect(persisted.entries.map((entry) => entry.agentId).sort()).toEqual(["arch", "cto"]);
  });

  it("rotates the operator credential and preserves the operator flag", async () => {
    const root = await mkdtemp(join(tmpdir(), "synloq-rotate-operator-project-"));
    const home = await mkdtemp(join(tmpdir(), "synloq-rotate-operator-home-"));
    vi.stubEnv("SYNLOQ_HOME", home);
    const store = new CredentialStore(root);
    const original = await store.issue("verdicta", "operator");

    const rotated = await store.rotate("verdicta", "operator");

    await expect(store.authenticate("verdicta", original)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(store.authenticate("verdicta", rotated.token)).resolves.toEqual({
      project: "verdicta",
      agentId: "operator",
      operator: true,
    });
  });

  it("rejects rotation for an agent without an existing credential", async () => {
    const root = await mkdtemp(join(tmpdir(), "synloq-rotate-missing-project-"));
    const home = await mkdtemp(join(tmpdir(), "synloq-rotate-missing-home-"));
    vi.stubEnv("SYNLOQ_HOME", home);
    const store = new CredentialStore(root);
    await store.issue("verdicta", "cto");

    await expect(store.rotate("verdicta", "arch")).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("revokes all hashes, removes the token file, and stays idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "synloq-revoke-project-"));
    const home = await mkdtemp(join(tmpdir(), "synloq-revoke-home-"));
    vi.stubEnv("SYNLOQ_HOME", home);
    const store = new CredentialStore(root);
    const ctoToken = await store.issue("verdicta", "cto");
    const rotated = await store.rotate("verdicta", "cto");

    const first = await store.revoke("verdicta", "cto");
    expect(first.removedHashes).toBe(1);
    await expect(readFile(first.tokenPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    for (const stale of [ctoToken, rotated.token]) {
      await expect(store.authenticate("verdicta", stale)).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
    }

    const second = await store.revoke("verdicta", "cto");
    expect(second.removedHashes).toBe(0);
  });
});
