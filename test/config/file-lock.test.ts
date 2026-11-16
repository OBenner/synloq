import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { withFileLock } from "../../src/config/file-lock.js";

const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
async function target() {
  const directory = await mkdtemp(join(tmpdir(), "synloq-lock-"));
  directories.push(directory);
  return join(directory, "credentials.json");
}

it("releases ownership after an operation fails", async () => {
  const path = await target();
  await expect(
    withFileLock(path, async () => {
      throw new Error("failed write");
    }),
  ).rejects.toThrow("failed write");
  await expect(withFileLock(path, async () => "next writer")).resolves.toBe("next writer");
});

it("fails closed on an existing lock, including stale or incomplete metadata", async () => {
  const path = await target();
  for (const metadata of ["", JSON.stringify({ pid: -1, createdAt: "2000-01-01" })]) {
    await writeFile(`${path}.lock`, metadata);
    let entered = false;
    await expect(
      withFileLock(
        path,
        async () => {
          entered = true;
        },
        50,
      ),
    ).rejects.toMatchObject({ code: "STORAGE_FAILURE" });
    expect(entered).toBe(false);
    expect(await readFile(`${path}.lock`, "utf8")).toBe(metadata);
  }
});
