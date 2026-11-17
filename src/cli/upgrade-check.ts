import { access } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { CURRENT_SCHEMA_VERSION } from "../storage/sqlite.js";

export interface UpgradeCheckReport {
  /** "fresh-install" — no database yet; "current" — nothing pending; "pending" — migration will run on next write open; "newer" — DB written by a newer release. */
  state: "fresh-install" | "current" | "pending" | "newer" | "unreadable";
  databasePath: string;
  schemaVersion?: number;
  expectedSchemaVersion: number;
  /** Human-readable description of what the pending migration does. */
  pendingMigration?: string;
  error?: string;
  /**
   * The 3-command upgrade path (#116). Always present so the output is a
   * self-contained checklist.
   */
  upgradePath: string[];
}

const UPGRADE_PATH = [
  "npm install -g synloq@latest   (or: npx synloq@latest …)",
  "synloq doctor --upgrade-check  (re-run this preview)",
  "synloq init --project-root <project>  (reconciles, migrates, regenerates channel configs)",
];

const MIGRATION_NOTES: Record<number, string> = {
  5: "v5→v6 adds the per-role memory notes table (automatic, additive)",
};

/**
 * Read-only upgrade preview (#116): reports the on-disk schema version and
 * what an upgrade will do BEFORE anything writes. Opens the database through
 * a read-only connection, so neither migrations nor WAL/journal writes
 * happen; the check is safe to run against a live stand.
 */
export async function upgradeCheck(options: { databasePath: string }): Promise<UpgradeCheckReport> {
  const base = {
    databasePath: options.databasePath,
    expectedSchemaVersion: CURRENT_SCHEMA_VERSION,
    upgradePath: UPGRADE_PATH,
  };
  try {
    await access(options.databasePath);
  } catch {
    return { ...base, state: "fresh-install" };
  }
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(options.databasePath, { readOnly: true });
    // Same bounded busy-retry as every other connection (issue #68): the
    // preview must wait out a relay writer, not fail instantly.
    database.exec("PRAGMA busy_timeout = 5000");
    const row = database.prepare("PRAGMA user_version").get() as
      { user_version: number } | undefined;
    const version = row?.user_version ?? 0;
    if (version > CURRENT_SCHEMA_VERSION) {
      return {
        ...base,
        state: "newer",
        schemaVersion: version,
        error: `database schema v${version} is newer than this binary supports (v${CURRENT_SCHEMA_VERSION}) — upgrade synloq first`,
      };
    }
    if (version === CURRENT_SCHEMA_VERSION) {
      return { ...base, state: "current", schemaVersion: version };
    }
    const migration =
      MIGRATION_NOTES[CURRENT_SCHEMA_VERSION] ??
      `v${version}→v${CURRENT_SCHEMA_VERSION} (automatic, forward-only)`;
    return {
      ...base,
      state: "pending",
      schemaVersion: version,
      pendingMigration: migration,
    };
  } catch (error) {
    return {
      ...base,
      state: "unreadable",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try {
      database?.close();
    } catch {
      /* best-effort close of a read-only probe */
    }
  }
}
