// @effect-diagnostics nodeBuiltinImport:off -- The offline importer and runtime share the same SQLite migrations.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type * as NodeSqlite from "node:sqlite";
import { pathToFileURL } from "node:url";

import { scriptAutomationSchema } from "./automations/schema.ts";
import { pipelineSchema } from "./pipeline/schema.ts";

export const forkDatabaseFilename = "pipeline.sqlite";

export function withForkTransaction<T>(db: NodeSqlite.DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

const migrations = [
  ["pipeline", pipelineSchema[0]],
  ["pipeline_reviews", pipelineSchema[1]],
  ["script_automations", scriptAutomationSchema],
] as const;

function hasTable(db: NodeSqlite.DatabaseSync, table: string) {
  return (
    db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table) !==
    undefined
  );
}

export function migrateForkDatabase(db: NodeSqlite.DatabaseSync): void {
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
  const location = db.location();
  const legacyPath =
    location && NodePath.basename(location) === forkDatabaseFilename
      ? NodePath.join(NodePath.dirname(location), "script-automations.sqlite")
      : null;
  const automationSchemaRecorded =
    hasTable(db, "fork_migrations") &&
    db.prepare("SELECT 1 FROM fork_migrations WHERE name = 'script_automations'").get() !==
      undefined;
  const hasLegacyAutomations =
    !automationSchemaRecorded && legacyPath !== null && NodeFS.existsSync(legacyPath);
  if (hasLegacyAutomations) {
    const source = pathToFileURL(legacyPath);
    source.searchParams.set("mode", "ro");
    db.prepare("ATTACH DATABASE ? AS legacy_automations").run(source.href);
  }
  try {
    withForkTransaction(db, () => {
      db.exec(`CREATE TABLE IF NOT EXISTS fork_migrations (
        migration_id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE
      ) STRICT;`);
      const record = db.prepare("INSERT INTO fork_migrations (migration_id, name) VALUES (?, ?)");
      if (hasTable(db, "pipeline_migrations")) {
        const legacy = db.prepare("SELECT version FROM pipeline_migrations ORDER BY version").all();
        if (
          legacy.length > pipelineSchema.length ||
          legacy.some((row, i) => row.version !== i + 1)
        ) {
          throw new Error("Invalid Pipeline migration ledger.");
        }
        for (const [i] of legacy.entries()) record.run(i + 1, migrations[i]![0]);
        db.exec("DROP TABLE pipeline_migrations");
      }
      const recorded = db
        .prepare("SELECT migration_id, name FROM fork_migrations ORDER BY migration_id")
        .all();
      if (
        recorded.length > migrations.length ||
        recorded.some((row, i) => row.migration_id !== i + 1 || row.name !== migrations[i]?.[0])
      ) {
        throw new Error("Invalid fork migration ledger.");
      }
      for (const [i, [name, sql]] of migrations.entries()) {
        if (i < recorded.length) continue;
        db.exec(sql);
        if (name === "script_automations" && hasLegacyAutomations) {
          db.exec(`
            INSERT INTO script_schedules SELECT id, cron, timezone, next_run_at, failures
              FROM legacy_automations.script_schedules;
            INSERT INTO script_runs SELECT job_id, due_at, started_at, finished_at, status,
                output, exit_code, reason FROM legacy_automations.script_runs;`);
        }
        record.run(i + 1, name);
      }
    });
  } finally {
    if (hasLegacyAutomations) db.exec("DETACH DATABASE legacy_automations");
  }
}
