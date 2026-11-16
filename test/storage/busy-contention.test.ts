import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import type { SendMessageInput } from "../../src/domain/message.js";
import { SQLiteMessageStore } from "../../src/storage/message-store.js";
import { openDatabase, storageFailure } from "../../src/storage/sqlite.js";

const input: SendMessageInput = {
  project: "verdicta",
  from: "cto",
  to: "arch",
  text: "contention probe",
  expectsReply: false,
  idempotencyKey: "cto-contention",
};

const directories: string[] = [];
const stores: SQLiteMessageStore[] = [];

function makeDatabase(): { path: string; store: SQLiteMessageStore } {
  const directory = mkdtempSync(join(tmpdir(), "synloq-busy-"));
  directories.push(directory);
  const path = join(directory, "data.sqlite");
  const store = new SQLiteMessageStore(path);
  stores.push(store);
  return { path, store };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("SQLite busy handling (issue #68)", () => {
  it("sets WAL and a bounded busy_timeout on every connection", () => {
    const { path } = makeDatabase();
    // The store does not expose its handle; open a connection the same way
    // (openDatabase) and read the pragmas back — busy_timeout is
    // per-connection, so this verifies what openDatabase itself establishes.
    const database = openDatabase(path);
    try {
      // node:sqlite reports the busy_timeout pragma under the column "timeout".
      const busy = database.prepare("PRAGMA busy_timeout").get() as { timeout: number };
      expect(busy.timeout).toBe(5000);
      const journal = database.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
      expect(journal.journal_mode).toBe("wal");
    } finally {
      database.close();
    }
  });

  it("opens an existing database read-only without migrating or locking writers out", () => {
    const { path, store } = makeDatabase();
    const id = crypto.randomUUID();
    const created = store.create(input, id, new Date().toISOString(), crypto.randomUUID());
    expect(created.created).toBe(true);

    // The read-only path used by watchdog / stored-ping / doctor / status:
    // no journal_mode pragma, no BEGIN IMMEDIATE migration transaction.
    const reader = new SQLiteMessageStore(path, undefined, { readOnly: true });
    stores.push(reader);
    expect(reader.getMessage(id, input.project)?.text).toBe(input.text);
    expect(reader.listInbox(input.project, input.to, undefined, 10).messages).toHaveLength(1);

    // A second read-write open of a fully migrated database (user_version = 4)
    // must not rerun the migration and must not fail.
    const reopened = new SQLiteMessageStore(path);
    stores.push(reopened);
    expect(reopened.getMessage(id, input.project)?.id).toBe(id);
  });

  it("surfaces the underlying SQLite errcode in STORAGE_FAILURE", () => {
    const busy = storageFailure("SQLite write failed", { errcode: 5 });
    expect(busy.code).toBe("STORAGE_FAILURE");
    expect(busy.message).toContain("SQLITE_BUSY");
    const locked = storageFailure("SQLite write failed", { errcode: 6 });
    expect(locked.message).toContain("SQLITE_LOCKED");
    const unknown = storageFailure("SQLite write failed", { errcode: 999 });
    expect(unknown.message).toContain("SQLITE_ERROR_999");
    const plain = storageFailure("SQLite write failed", new Error("nope"));
    expect(plain.message).toBe("SQLite write failed");
  });

  it("a write waits out a concurrent writer instead of failing with STORAGE_FAILURE", async () => {
    const { path, store } = makeDatabase();
    // A worker thread simulates the external contender (AV scan, another
    // process): it holds BEGIN IMMEDIATE for ~400 ms while the main thread
    // writes through the store. It signals once the lock is held so the
    // timing below does not depend on worker startup latency.
    const worker = new Worker(
      `const { DatabaseSync } = require("node:sqlite");
       const { workerData, parentPort } = require("worker_threads");
       const db = new DatabaseSync(workerData.path);
       db.exec("BEGIN IMMEDIATE");
       db.prepare("CREATE TABLE IF NOT EXISTS holder (id INTEGER)").run();
       parentPort.postMessage("locked");
       const deadline = Date.now() + workerData.holdMs;
       while (Date.now() < deadline) {}
       db.exec("COMMIT");
       db.close();
       parentPort.postMessage("released");`,
      { eval: true, workerData: { path, holdMs: 400 } },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        worker.once("message", () => resolve());
        worker.once("error", reject);
        worker.once("exit", (code) => reject(new Error(`worker exited early: ${code}`)));
      });

      // With busy_timeout this blocks until the worker commits; without it
      // this throws STORAGE_FAILURE [SQLITE_BUSY] immediately.
      const startedAt = Date.now();
      const result = store.create(
        input,
        crypto.randomUUID(),
        new Date().toISOString(),
        crypto.randomUUID(),
      );
      expect(result.created).toBe(true);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);
    } finally {
      await new Promise<void>((resolve) => worker.once("exit", () => resolve()));
      await worker.terminate();
    }
  }, 10_000);
});
