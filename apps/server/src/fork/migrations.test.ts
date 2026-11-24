// @effect-diagnostics nodeBuiltinImport:off -- Exercise adoption of the worker databases on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { expect, test } from "vite-plus/test";

import { scriptAutomationSchema } from "./automations/schema.ts";
import { forkDatabaseFilename, migrateForkDatabase } from "./migrations.ts";
import { pipelineSchema } from "./pipeline/schema.ts";

test("adopts both worker databases once and keeps the old script ledger available for rollback", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-db-"));
  try {
    const target = NodePath.join(root, forkDatabaseFilename);
    const source = NodePath.join(root, "script-automations.sqlite");
    {
      using pipeline = new NodeSqlite.DatabaseSync(target);
      for (const sql of pipelineSchema) pipeline.exec(sql);
      pipeline.exec(`
        CREATE TABLE pipeline_migrations (version INTEGER PRIMARY KEY) STRICT;
        INSERT INTO pipeline_migrations VALUES (1), (2);
        INSERT INTO task_limits VALUES ('project', 'executor', 5);
      `);
      using automations = new NodeSqlite.DatabaseSync(source);
      automations.exec(scriptAutomationSchema);
      automations.exec(`
        INSERT INTO script_schedules VALUES ('check', '* * * * *', 'UTC', 10, 1);
        INSERT INTO script_runs (job_id, due_at, started_at, status) VALUES ('check', 5, 5, 'running');
      `);
    }
    {
      using db = new NodeSqlite.DatabaseSync(target);
      migrateForkDatabase(db);
      expect(db.prepare("SELECT task_limit FROM task_limits").get()?.task_limit).toBe(5);
      expect(db.prepare("SELECT next_run_at FROM script_schedules").get()?.next_run_at).toBe(10);
      expect(db.prepare("SELECT status FROM script_runs").get()?.status).toBe("running");
      expect(db.prepare("SELECT name FROM fork_migrations ORDER BY migration_id").all()).toEqual([
        { name: "pipeline" },
        { name: "pipeline_reviews" },
        { name: "script_automations" },
      ]);
      expect(
        db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'pipeline_migrations'").get(),
      ).toBeUndefined();
      db.exec("UPDATE script_runs SET status = 'skipped';");
    }
    {
      using db = new NodeSqlite.DatabaseSync(target);
      migrateForkDatabase(db);
      expect(db.prepare("SELECT status FROM script_runs").all()).toEqual([{ status: "skipped" }]);
      using legacy = new NodeSqlite.DatabaseSync(source, { readOnly: true });
      expect(legacy.prepare("SELECT status FROM script_runs").all()).toEqual([
        { status: "running" },
      ]);
    }
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
