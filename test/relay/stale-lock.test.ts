import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { acquireServeLock, probeProcess } from "../../src/relay/serve-lock.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
it("retains both the original refusal and a failing rollback", async () => {
  const db = fixture();
  const rollbackError = new Error("rollback failed");
  const exec = DatabaseSync.prototype.exec;
  vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ) {
    if (sql === "ROLLBACK") throw rollbackError;
    return exec.call(this, sql);
  });
  const error = await acquireServeLock(db, { probePid: () => "alive" }).catch(
    (error: unknown) => error,
  );
  expect(error).toMatchObject({ code: "STORAGE_FAILURE", cause: expect.any(AggregateError) });
  const aggregate = (error as Error).cause as AggregateError;
  expect(aggregate.errors[0]).toMatchObject({ code: "ALREADY_RUNNING" });
  expect(aggregate.errors[1]).toBe(rollbackError);
  expect(aggregate.cause).toBe(aggregate.errors[0]);
});
function fixture(body = JSON.stringify({ pid: 12345, startedAt: "2026-01-01" })) {
  const root = mkdtempSync(join(tmpdir(), "synloq-stale-"));
  roots.push(root);
  const db = join(root, "project.sqlite");
  writeFileSync(`${db}.serve.lock`, body);
  return db;
}
it("recovers only a positively dead owner and reports its PID", async () => {
  const db = fixture();
  const diagnostic = vi.fn();
  const lock = await acquireServeLock(db, { probePid: () => "dead", onDiagnostic: diagnostic });
  expect(JSON.parse(readFileSync(lock.path, "utf8")).pid).toBe(process.pid);
  expect(diagnostic).toHaveBeenCalledWith("recovered stale serve lock (pid 12345)");
  await lock.release();
});
it("fresh acquisition does not need the recovery mutex", async () => {
  const db = fixture();
  unlinkSync(`${db}.serve.lock`);
  const lock = await acquireServeLock(db);
  expect(existsSync(`${db}.serve.lock.mutex.sqlite`)).toBe(false);
  await lock.release();
});
it("refuses recovery when the mutex sidecar cannot be used", async () => {
  const db = fixture();
  const original = readFileSync(`${db}.serve.lock`, "utf8");
  writeFileSync(`${db}.serve.lock.mutex.sqlite`, "not a sqlite database");
  await expect(acquireServeLock(db, { probePid: () => "dead" })).rejects.toMatchObject({
    code: "STORAGE_FAILURE",
  });
  expect(readFileSync(`${db}.serve.lock`, "utf8")).toBe(original);
});
it.each(["alive", "unknown"] as const)("preserves %s owner's lock", async (state) => {
  const db = fixture();
  const before = readFileSync(`${db}.serve.lock`, "utf8");
  await expect(acquireServeLock(db, { probePid: () => state })).rejects.toMatchObject({
    code: "ALREADY_RUNNING",
  });
  expect(readFileSync(`${db}.serve.lock`, "utf8")).toBe(before);
});
it.each(["{}", "not-json", '{"pid":0}', '{"pid":-1}', '{"pid":"123"}'])(
  "preserves malformed owner %s",
  async (body) => {
    const db = fixture(body);
    const probe = vi.fn(() => "dead" as const);
    await expect(acquireServeLock(db, { probePid: probe })).rejects.toMatchObject({
      code: "ALREADY_RUNNING",
    });
    expect(probe).not.toHaveBeenCalled();
    expect(readFileSync(`${db}.serve.lock`, "utf8")).toBe(body);
  },
);
it("classifies only ESRCH as dead, never permissions or unknown failures", () => {
  expect(probeProcess(process.pid)).toBe("alive");
  for (const [code, state] of [
    ["ESRCH", "dead"],
    ["EPERM", "unknown"],
    ["EACCES", "unknown"],
    ["EINVAL", "unknown"],
  ]) {
    expect(
      probeProcess(123, () => {
        throw Object.assign(new Error("private"), { code });
      }),
    ).toBe(state);
  }
});
it("an old release cannot remove a replacement owner's lock", async () => {
  const db = fixture();
  const lock = await acquireServeLock(db, { probePid: () => "dead" });
  const replacement = JSON.stringify({ pid: process.pid, ownerId: "replacement" });
  writeFileSync(lock.path, replacement);
  await lock.release();
  await lock.release();
  expect(readFileSync(lock.path, "utf8")).toBe(replacement);
});
it("diagnostic callback failures do not strand acquired ownership", async () => {
  const db = fixture();
  const lock = await acquireServeLock(db, {
    probePid: () => "dead",
    onDiagnostic: () => {
      throw new Error("sink closed");
    },
  });
  await lock.release();
});
