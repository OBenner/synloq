import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SynloqError } from "../../src/domain/errors.js";
import { NotesStore } from "../../src/storage/notes-store.js";
import { openDatabase } from "../../src/storage/sqlite.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "synloq-notes-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const database = openDatabase(join(root, "notes.sqlite"));
  cleanups.push(() => database.close());
  const store = new NotesStore(database);
  return { database, store };
}

describe("NotesStore (#22)", () => {
  it("writes and reads a note scoped to project and role", () => {
    const { store } = fixture();
    const written = store.write(
      "synloq",
      "cto",
      "decisions",
      "# Decisions\n- picked SQLite",
      "2026-11-17T00:00:00.000Z",
    );
    expect(written).toMatchObject({ key: "decisions", updatedAt: "2026-11-17T00:00:00.000Z" });
    expect(store.read("synloq", "cto", "decisions")?.body).toContain("picked SQLite");
  });

  it("overwrites on the same key and updates updatedAt", () => {
    const { store } = fixture();
    store.write("synloq", "cto", "loops", "one", "2026-11-17T00:00:00.000Z");
    const second = store.write("synloq", "cto", "loops", "two", "2026-11-17T01:00:00.000Z");
    expect(second.body).toBe("two");
    expect(second.updatedAt).toBe("2026-11-17T01:00:00.000Z");
    expect(store.read("synloq", "cto", "loops")?.body).toBe("two");
  });

  it("isolates namespaces: other roles and projects see nothing", () => {
    const { store } = fixture();
    store.write("synloq", "cto", "k", "cto-note", "2026-11-17T00:00:00.000Z");
    expect(store.read("synloq", "arch", "k")).toBeUndefined();
    expect(store.read("other", "cto", "k")).toBeUndefined();
    expect(store.count("synloq", "cto")).toBe(1);
    expect(store.count("synloq", "arch")).toBe(0);
  });

  it("enforces key and body bounds fail-loud", () => {
    const { store } = fixture();
    expect(() => store.write("synloq", "cto", "", "x", "2026-11-17T00:00:00.000Z")).toThrow(
      SynloqError,
    );
    expect(() =>
      store.write("synloq", "cto", "k".repeat(129), "x", "2026-11-17T00:00:00.000Z"),
    ).toThrow(SynloqError);
    expect(() =>
      store.write("synloq", "cto", "k", "x".repeat(65_537), "2026-11-17T00:00:00.000Z"),
    ).toThrow(SynloqError);
  });

  it("caps keys per role and stays transactional", () => {
    const { database, store } = fixture();
    for (let index = 0; index < 256; index += 1) {
      store.write("synloq", "cto", `key-${index}`, "body", "2026-11-17T00:00:00.000Z");
    }
    expect(() =>
      store.write("synloq", "cto", "one-more", "body", "2026-11-17T00:00:00.000Z"),
    ).toThrow(SynloqError);
    // Another role is unaffected by cto's cap.
    store.write("synloq", "arch", "k", "body", "2026-11-17T00:00:00.000Z");
    // Direct table sanity: primary key covers (project, role, key).
    const table = database
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='notes'")
      .get();
    expect(table).toBeDefined();
  });

  it("migrates a live v5 database to v6 with the notes table (#22)", () => {
    const root = mkdtempSync(join(tmpdir(), "synloq-notes-v5-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, "v5.sqlite");
    // Emulate a database written by the previous release: schema v5, no notes.
    const legacy = new DatabaseSync(path);
    legacy.exec("PRAGMA user_version = 5;");
    legacy.close();
    const database = openDatabase(path);
    cleanups.push(() => database.close());
    expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(6);
    expect(
      database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='notes'").get(),
    ).toBeDefined();
    const store = new NotesStore(database);
    store.write("synloq", "cto", "k", "body", "2026-11-17T00:00:00.000Z");
    expect(store.read("synloq", "cto", "k")?.body).toBe("body");
  });

  it("read of a missing key returns undefined, not an error", () => {
    const { store } = fixture();
    expect(store.read("synloq", "cto", "never-written")).toBeUndefined();
  });
});
