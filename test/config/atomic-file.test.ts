import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeJsonAtomic, writeTextAtomic } from "../../src/config/atomic-file.js";
import { CredentialStore } from "../../src/config/credentials.js";
import { projectPaths } from "../../src/config/paths.js";

// Sandboxed runners fail with EPERM/EACCES; simulating that portably (Windows
// included) means mocking the write syscall rather than chmod games.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: vi.fn(async (path: unknown) => {
      throw Object.assign(new Error(`EPERM: operation not permitted, open '${String(path)}'`), {
        code: "EPERM",
      });
    }),
  };
});

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("atomic file writes under permission errors", () => {
  it("fails loud with the path, the operation, and the --synloq-home hint", async () => {
    const home = await temporaryDirectory("synloq-eperm-home-");
    const target = join(home, "state", "bindings.json");

    const failure = await writeJsonAtomic(target, { version: 1 }).catch((error: unknown) => error);

    expect(failure).toMatchObject({ name: "SynloqError", code: "PERMISSION_DENIED" });
    const message = (failure as Error).message;
    expect(message).toContain(target);
    expect(message).toContain("EPERM");
    expect(message).toContain("writing a file atomically");
    expect(message).toContain("--synloq-home");
    expect((failure as Error).cause).toMatchObject({ code: "EPERM" });
  });

  it("wraps text writes the same way", async () => {
    const home = await temporaryDirectory("synloq-eperm-home-");
    const target = join(home, "tokens", "cto.token");

    await expect(writeTextAtomic(target, "token\n")).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
  });
});

describe("CredentialStore under permission errors", () => {
  it("reports EPERM on the credentials file with its concrete path", async () => {
    const root = await temporaryDirectory("synloq-eperm-project-");
    const home = await temporaryDirectory("synloq-eperm-home-");
    vi.stubEnv("SYNLOQ_HOME", home);
    const store = new CredentialStore(root);

    const failure = await store.issue("verdicta", "cto").catch((error: unknown) => error);

    expect(failure).toMatchObject({ name: "SynloqError", code: "PERMISSION_DENIED" });
    const paths = await projectPaths(root);
    expect((failure as Error).message).toContain(paths.credentials);
    expect((failure as Error).message).toContain("--synloq-home");
  });
});
