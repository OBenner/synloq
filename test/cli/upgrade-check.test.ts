import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION } from "../../src/storage/sqlite.js";
import { upgradeCheck } from "../../src/cli/upgrade-check.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function databaseAt(version: number | undefined): string {
  const dir = mkdtempSync(join(tmpdir(), "synloq-upgrade-check-"));
  dirs.push(dir);
  const path = join(dir, "stand.sqlite");
  if (version !== undefined) {
    const database = new DatabaseSync(path);
    database.exec(`PRAGMA user_version = ${version};`);
    database.close();
  }
  return path;
}

describe("doctor --upgrade-check (#116)", () => {
  it("reports fresh-install when no database exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "synloq-upgrade-empty-"));
    dirs.push(dir);
    const report = await upgradeCheck({ databasePath: join(dir, "missing.sqlite") });
    expect(report.state).toBe("fresh-install");
    expect(report.upgradePath).toHaveLength(3);
  });

  it("reports current when the schema matches this binary", async () => {
    const report = await upgradeCheck({ databasePath: databaseAt(CURRENT_SCHEMA_VERSION) });
    expect(report.state).toBe("current");
    expect(report.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(report.pendingMigration).toBeUndefined();
  });

  it("reports a pending migration WITHOUT writing anything", async () => {
    const path = databaseAt(CURRENT_SCHEMA_VERSION - 1);
    const report = await upgradeCheck({ databasePath: path });
    expect(report.state).toBe("pending");
    expect(report.schemaVersion).toBe(CURRENT_SCHEMA_VERSION - 1);
    expect(report.pendingMigration).toContain("v");
    // Read-only proof: the probe must not migrate or create objects.
    const inspector = new DatabaseSync(path, { readOnly: true });
    try {
      expect(inspector.prepare("PRAGMA user_version").get()?.user_version).toBe(
        CURRENT_SCHEMA_VERSION - 1,
      );
      const notes = inspector
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='notes'")
        .get();
      expect(notes).toBeUndefined();
    } finally {
      inspector.close();
    }
  });

  it("fail-loud reports a database newer than this binary", async () => {
    const report = await upgradeCheck({ databasePath: databaseAt(CURRENT_SCHEMA_VERSION + 1) });
    expect(report.state).toBe("newer");
    expect(report.error).toContain("newer");
  });
});
