import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { SQLiteMessageStore } from "../../src/storage/message-store.js";
import { SynloqError } from "../../src/domain/errors.js";
import { CURRENT_SCHEMA_VERSION, openDatabase } from "../../src/storage/sqlite.js";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function path() {
  const root = mkdtempSync(join(tmpdir(), "synloq-retention-migrate-"));
  directories.push(root);
  return join(root, "state.sqlite");
}

it.each([0, 1, 2, 3, 4])(
  "migrates legacy v%s without losing bodies, reply IDs or quarantine and persists a body-free ledger",
  (version) => {
    const file = path();
    const legacy = new DatabaseSync(file);
    legacy.exec(`CREATE TABLE messages (
    id TEXT PRIMARY KEY, project TEXT NOT NULL, thread_id TEXT NOT NULL, sender TEXT NOT NULL,
    recipient TEXT NOT NULL, text TEXT NOT NULL, expects_reply INTEGER NOT NULL,
    in_reply_to TEXT REFERENCES messages(id), created_at TEXT NOT NULL, idempotency_key TEXT NOT NULL,
    delivery_state TEXT NOT NULL, UNIQUE(project, sender, idempotency_key));
    INSERT INTO messages VALUES ('parent', 'test', 'thread', 'dev', 'staff', 'private-parent', 1, NULL, '2026-11-01T00:00:00.000Z', 'p', 'acked');
    INSERT INTO messages VALUES ('child', 'test', 'thread', 'staff', 'dev', 'private-child', 0, 'parent', '2026-11-01T00:00:00.000Z', 'c', 'stored');
    CREATE TABLE delivery_quarantine (message_id TEXT PRIMARY KEY REFERENCES messages(id), project TEXT NOT NULL, recipient TEXT NOT NULL, quarantined_at TEXT NOT NULL);
    INSERT INTO delivery_quarantine VALUES ('child', 'test', 'dev', '2026-11-01T00:00:00.000Z');
    PRAGMA user_version = ${version};`);
    legacy.close();
    const clock = { now: () => Date.parse("2026-11-03T00:00:00Z") };
    let store = new SQLiteMessageStore(file, clock);
    expect(store.getMessage("child", "test")?.inReplyTo).toBe("parent");
    expect(store.sweepRetention("test", 1).messagesPurged).toBe(1);
    store.close();
    store = new SQLiteMessageStore(file, clock);
    try {
      const retry = store.create(
        {
          project: "test",
          from: "dev",
          to: "staff",
          text: "private-parent",
          expectsReply: true,
          idempotencyKey: "p",
        },
        "new",
        new Date(clock.now()).toISOString(),
        "new-thread",
      );
      expect(retry).toMatchObject({
        created: false,
        message: { id: "parent", text: "private-parent", deliveryState: "acked" },
      });
      const inspector = openDatabase(file);
      try {
        expect(inspector.prepare("PRAGMA user_version").get()?.user_version).toBe(5);
        expect(inspector.prepare("PRAGMA foreign_key_list(messages)").all()).toEqual([]);
        expect(inspector.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(inspector.prepare("SELECT COUNT(*) AS n FROM delivery_quarantine").get()?.n).toBe(1);
        const ledger = inspector.prepare("SELECT * FROM message_dedup").all();
        expect(ledger).toHaveLength(2);
        expect(JSON.stringify(ledger)).not.toContain("private-");
        expect(ledger[0]).not.toHaveProperty("text");
      } finally {
        inspector.close();
      }
    } finally {
      store.close();
    }
  },
);

it.each([false, true])(
  "refuses unknown schema versions, readOnly=%s, without changing them",
  (readOnly) => {
    const file = path();
    const db = new DatabaseSync(file);
    db.exec("PRAGMA user_version = 999");
    db.close();
    // #113: the refusal names both versions and the escape hatch.
    expect(() => openDatabase(file, { readOnly })).toThrow(
      expect.objectContaining({
        code: "STORAGE_FAILURE",
        message: expect.stringContaining("schema version 999"),
      }),
    );
    const inspector = new DatabaseSync(file);
    expect(inspector.prepare("PRAGMA user_version").get()?.user_version).toBe(999);
    inspector.close();
  },
);

it("rolls back the complete migration on foreign-key validation failure", () => {
  const file = path();
  const legacy = new DatabaseSync(file);
  legacy.exec(`PRAGMA foreign_keys = OFF;
    CREATE TABLE delivery_quarantine (message_id TEXT PRIMARY KEY REFERENCES messages(id), project TEXT NOT NULL, recipient TEXT NOT NULL, quarantined_at TEXT NOT NULL);
    INSERT INTO delivery_quarantine VALUES ('missing', 'test', 'staff', '2026-11-01');
    PRAGMA user_version = 4;`);
  legacy.close();
  expect(() => openDatabase(file)).toThrow(expect.objectContaining({ code: "STORAGE_FAILURE" }));
  const inspector = new DatabaseSync(file);
  try {
    expect(inspector.prepare("PRAGMA user_version").get()?.user_version).toBe(4);
    expect(inspector.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([
      { name: "delivery_quarantine" },
    ]);
    expect(inspector.prepare("SELECT message_id FROM delivery_quarantine").get()?.message_id).toBe(
      "missing",
    );
  } finally {
    inspector.close();
  }
});

it("names both versions and the escape hatch when the DB is newer than the binary (#113)", () => {
  const file = path();
  const newer = new DatabaseSync(file);
  newer.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION + 1}`);
  newer.close();

  const error = (() => {
    try {
      openDatabase(file);
      return undefined;
    } catch (failure) {
      return failure;
    }
  })();
  expect(error).toBeInstanceOf(SynloqError);
  const failure = error as SynloqError;
  expect(failure.code).toBe("STORAGE_FAILURE");
  expect(failure.message).toContain(`schema version ${CURRENT_SCHEMA_VERSION + 1}`);
  expect(failure.message).toContain(`supports up to ${CURRENT_SCHEMA_VERSION}`);
  expect(failure.message).toContain("npm i -g synloq@latest");
  expect(failure.message).toContain("forward-only");
});
