import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { writeTextAtomic } from "../../src/config/atomic-file.js";

const fault = vi.hoisted(() => ({ stage: "", events: [] as string[] }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const temporary = String(args[0]).endsWith(".tmp");
      return {
        writeFile: async (...values: Parameters<typeof handle.writeFile>) => {
          fault.events.push("write");
          if (fault.stage === "write") {
            await handle.writeFile("partial");
            throw new Error("injected write failure");
          }
          return handle.writeFile(...values);
        },
        sync: async () => {
          fault.events.push(temporary ? "sync-file" : "sync-directory");
          if (fault.stage === "sync") throw new Error("injected sync failure");
          return handle.sync();
        },
        close: async () => {
          fault.events.push(temporary ? "close-file" : "close-directory");
          await handle.close();
        },
      };
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      fault.events.push("rename");
      if (fault.stage === "rename") throw new Error("injected rename failure");
      return actual.rename(...args);
    },
  };
});

const directories: string[] = [];
afterEach(async () => {
  fault.stage = "";
  fault.events = [];
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "synloq-durability-"));
  directories.push(directory);
  const path = join(directory, "state.json");
  await writeFile(path, '{"previous":true}\n');
  return { directory, path };
}

it.each(["write", "sync", "rename"])(
  "preserves previous valid state on %s failure",
  async (stage) => {
    const { directory, path } = await fixture();
    fault.stage = stage;
    await expect(writeTextAtomic(path, '{"next":true}\n')).rejects.toThrow(
      `injected ${stage} failure`,
    );
    expect(await readFile(path, "utf8")).toBe('{"previous":true}\n');
    expect(await readdir(directory)).toEqual(["state.json"]);
    if (stage !== "rename") expect(fault.events).not.toContain("rename");
  },
);

it("syncs and closes the temporary file before publishing it", async () => {
  const { path } = await fixture();
  await writeTextAtomic(path, '{"next":true}\n');
  expect(fault.events).toEqual(
    process.platform === "win32"
      ? ["write", "sync-file", "close-file", "rename"]
      : ["write", "sync-file", "close-file", "rename", "sync-directory", "close-directory"],
  );
  expect(await readFile(path, "utf8")).toBe('{"next":true}\n');
});
