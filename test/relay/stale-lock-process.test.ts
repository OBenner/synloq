import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { afterEach, expect, it } from "vitest";
import { acquireServeLock } from "../../src/relay/serve-lock.js";

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode === null && child.signalCode === null) {
        const exit = once(child, "exit");
        child.kill();
        await exit;
      }
    }),
  );
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "synloq-lock-process-"));
  roots.push(root);
  // Transpile the actual production modules for independent Node processes, without
  // relying on a pre-existing dist (verify builds only after tests).
  for (const [source, target] of [
    ["../../src/relay/serve-lock.ts", "lock.mjs"],
    ["../../src/domain/errors.ts", "errors.mjs"],
  ]) {
    const text = readFileSync(new URL(source!, import.meta.url), "utf8").replace(
      "../domain/errors.js",
      "./errors.mjs",
    );
    writeFileSync(join(root, target!), stripTypeScriptTypes(text, { mode: "transform" }));
  }
  writeFileSync(
    join(root, "child.mjs"),
    `
    import {acquireServeLock} from './lock.mjs';
    import {DatabaseSync} from 'node:sqlite';
    const [db,mode]=process.argv.slice(2);
    process.on('message', async message=>{
      if(message==='start') {
        try {
          if(mode==='mutex') {
            const mutex=new DatabaseSync(db+'.serve.lock.mutex.sqlite');
            mutex.exec('BEGIN IMMEDIATE'); globalThis.mutex=mutex;
          } else { globalThis.lock=await acquireServeLock(db); }
          process.send({state:'acquired'});
        } catch(error) { process.send({state:'refused',code:error.code}); }
      }
    });
    process.send({state:'ready'});
  `,
  );
  return { root, db: join(root, "project.sqlite") };
}
async function child(root: string, db: string, mode = "lock") {
  const process = fork(join(root, "child.mjs"), [db, mode], { silent: true, execArgv: [] });
  children.push(process);
  await once(process, "message");
  return process;
}
async function start(process: ChildProcess) {
  const reply = once(process, "message");
  process.send("start");
  return (await reply)[0];
}
async function kill(process: ChildProcess) {
  const exit = once(process, "exit");
  process.kill("SIGKILL");
  await exit;
}
it(
  "elects one owner after a verified crash, and recovers again after that winner dies",
  { timeout: 20000 },
  async () => {
    const { root, db } = fixture();
    const first = await child(root, db);
    expect(await start(first)).toEqual({ state: "acquired" });
    await kill(first);
    const contenders = await Promise.all([child(root, db), child(root, db), child(root, db)]);
    const results = await Promise.all(contenders.map(start));
    expect(results.filter((result) => result.state === "acquired")).toHaveLength(1);
    expect(results.filter((result) => result.state === "refused")).toEqual([
      { state: "refused", code: "ALREADY_RUNNING" },
      { state: "refused", code: "ALREADY_RUNNING" },
    ]);
    const winner = contenders[results.findIndex((result) => result.state === "acquired")]!;
    expect(JSON.parse(readFileSync(`${db}.serve.lock`, "utf8")).pid).toBe(winner.pid);
    await kill(winner);
    const diagnostics: string[] = [];
    const recovered = await acquireServeLock(db, {
      onDiagnostic: (message) => diagnostics.push(message),
    });
    expect(diagnostics).toEqual([`recovered stale serve lock (pid ${winner.pid})`]);
    await recovered.release();
  },
);
it("OS releases the recovery mutex when its process is killed", { timeout: 15000 }, async () => {
  const { root, db } = fixture();
  const holder = await child(root, db, "mutex");
  expect(await start(holder)).toEqual({ state: "acquired" });
  // Force the recovery path: a fresh wx acquisition intentionally bypasses the mutex.
  writeFileSync(`${db}.serve.lock`, JSON.stringify({ pid: holder.pid }));
  await kill(holder);
  const lock = await acquireServeLock(db);
  await lock.release();
});
