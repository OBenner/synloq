import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { CredentialStore } from "../../src/config/credentials.js";
import { projectPaths } from "../../src/config/paths.js";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "synloq-credential-race-"));
  directories.push(root);
  const home = join(root, "home");
  return { root, home, paths: await projectPaths(root, home) };
}

it("preserves every concurrent issuance from independent stores", async () => {
  const { root, home, paths } = await fixture();
  const tokens = await Promise.all(
    Array.from({ length: 12 }, (_, i) => new CredentialStore(root, home).issue("test", `role${i}`)),
  );
  const entries = JSON.parse(await readFile(paths.credentials, "utf8")).entries;
  expect(entries).toHaveLength(tokens.length);
  for (const [i, token] of tokens.entries()) {
    await expect(
      new CredentialStore(root, home).authenticate("test", token),
    ).resolves.toMatchObject({ agentId: `role${i}` });
  }
});

it("serializes ensure through the token write, issuing just once", async () => {
  const { root, home, paths } = await fixture();
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      new CredentialStore(root, home).ensureCredential("test", "dev"),
    ),
  );
  expect(new Set(results.map((r) => r.token)).size).toBe(1);
  expect(results.filter((r) => !r.reused)).toHaveLength(1);
  expect(JSON.parse(await readFile(paths.credentials, "utf8")).entries).toHaveLength(1);
  expect((await readFile(results[0]!.tokenPath, "utf8")).trim()).toBe(results[0]!.token);
});

it("serializes issuance, ensure, rotation and revocation across processes", async () => {
  const { root, home, paths } = await fixture();
  const children = Array.from({ length: 4 }, (_, i) =>
    fork(
      fileURLToPath(new URL("../helpers/credential-worker.mjs", import.meta.url)),
      [root, home, String(i)],
      {
        execArgv: ["--experimental-transform-types"],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    ),
  );
  try {
    const results = await Promise.all(
      children.map(
        (child) =>
          new Promise<{ shared: { token: string; reused: boolean }; role: string; token: string }>(
            (resolve, reject) => {
              let stderr = "";
              let result:
                | { shared: { token: string; reused: boolean }; role: string; token: string }
                | undefined;
              child.stderr!.on("data", (data) => {
                stderr += String(data);
              });
              child.on("error", reject);
              child.on("message", (message) => {
                if (message === "ready") child.send("go");
                else result = message as typeof result;
              });
              child.on("exit", (code) =>
                code === 0 && result
                  ? resolve(result)
                  : reject(new Error(`worker failed (${code}): ${stderr}`)),
              );
            },
          ),
      ),
    );
    expect(new Set(results.map((r) => r.shared.token)).size).toBe(1);
    expect(results.filter((r) => !r.shared.reused)).toHaveLength(1);
    const store = new CredentialStore(root, home);
    for (const [i, result] of results.entries()) {
      if (i % 2 === 0)
        await expect(store.authenticate("test", result.token)).rejects.toMatchObject({
          code: "UNAUTHORIZED",
        });
      else
        await expect(store.authenticate("test", result.token)).resolves.toMatchObject({
          agentId: result.role,
        });
    }
    expect(JSON.parse(await readFile(paths.credentials, "utf8")).entries).toHaveLength(3);
    await expect(readFile(`${paths.credentials}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
  }
}, 20_000);
