import { fork } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("retains previous valid state when the writer is killed before rename", async () => {
  const root = await mkdtemp(join(tmpdir(), "synloq-crash-"));
  const path = join(root, "state.json");
  await writeFile(path, '{"previous":true}\n');
  const child = fork(
    fileURLToPath(new URL("../helpers/atomic-crash-worker.mjs", import.meta.url)),
    [path],
    {
      execArgv: ["--experimental-transform-types"],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("writer did not reach rename")), 5000);
      child.once("error", reject);
      child.once("message", (message) => {
        clearTimeout(timeout);
        if (message === "before-rename") resolve();
        else reject(new Error("unexpected worker response"));
      });
      child.once("exit", () => {
        clearTimeout(timeout);
        reject(new Error("writer exited before rename"));
      });
    });
    child.kill("SIGKILL");
    await exited;
    expect(await readFile(path, "utf8")).toBe('{"previous":true}\n');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);
