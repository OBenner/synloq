import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SQLiteMessageStore } from "../../src/storage/message-store.js";

const stores: SQLiteMessageStore[] = [];
const temporaryDirectories: string[] = [];
const pausedAt = "2026-11-09T00:00:00.000Z";

function makeStore(path = ":memory:"): SQLiteMessageStore {
  const store = new SQLiteMessageStore(path);
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SQLiteMessageStore pause gates", () => {
  it("applies a project pause to participant and thread delivery checks", () => {
    const store = makeStore();

    store.pause("verdicta", "project", "", pausedAt);

    expect(store.isPaused("verdicta", "project", "")).toBe(true);
    expect(store.isPaused("verdicta", "participant", "arch")).toBe(true);
    expect(store.isPaused("verdicta", "thread", "thread-1")).toBe(true);
    expect(store.isPaused("another-project", "participant", "arch")).toBe(false);
  });

  it("keeps participant and thread pauses independent", () => {
    const store = makeStore();

    store.pause("verdicta", "participant", "arch", pausedAt);
    store.pause("verdicta", "thread", "thread-1", pausedAt);

    expect(store.isPaused("verdicta", "participant", "arch")).toBe(true);
    expect(store.isPaused("verdicta", "participant", "cto")).toBe(false);
    expect(store.isPaused("verdicta", "thread", "thread-1")).toBe(true);
    expect(store.isPaused("verdicta", "thread", "thread-2")).toBe(false);
    expect(store.isPaused("verdicta", "project", "")).toBe(false);
  });

  it("keeps a project pause effective when a participant gate is resumed", () => {
    const store = makeStore();
    store.pause("verdicta", "project", "", pausedAt);
    store.pause("verdicta", "participant", "arch", pausedAt);

    store.resume("verdicta", "participant", "arch");

    expect(store.isPaused("verdicta", "participant", "arch")).toBe(true);
    store.resume("verdicta", "project", "");
    expect(store.isPaused("verdicta", "participant", "arch")).toBe(false);
  });

  it("keeps a participant pause effective when a project gate is resumed", () => {
    const store = makeStore();
    store.pause("verdicta", "project", "", pausedAt);
    store.pause("verdicta", "participant", "arch", pausedAt);

    store.resume("verdicta", "project", "");

    expect(store.isPaused("verdicta", "participant", "arch")).toBe(true);
    store.resume("verdicta", "participant", "arch");
    expect(store.isPaused("verdicta", "participant", "arch")).toBe(false);
  });

  it("persists pause and resume changes after reopening SQLite", () => {
    const directory = mkdtempSync(join(tmpdir(), "synloq-pause-reopen-"));
    temporaryDirectories.push(directory);
    const database = join(directory, "messages.sqlite");
    const firstStore = makeStore(database);
    firstStore.pause("verdicta", "thread", "thread-1", pausedAt);
    firstStore.close();

    const reopened = makeStore(database);
    expect(reopened.isPaused("verdicta", "thread", "thread-1")).toBe(true);
    reopened.resume("verdicta", "thread", "thread-1");
    reopened.close();

    const resumed = makeStore(database);
    expect(resumed.isPaused("verdicta", "thread", "thread-1")).toBe(false);
  });
});
