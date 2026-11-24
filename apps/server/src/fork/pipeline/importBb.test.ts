// @effect-diagnostics nodeBuiltinImport:off -- Exercise the offline import across SQLite files.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { expect, test } from "vite-plus/test";

import { bbProjectId, bbThreadId } from "../history/ids.ts";
import { importBbPipeline } from "./importBb.ts";

test("links Pipeline cards only to verified History imports and reuses History's project IDs", () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pipeline-history-"));
  try {
    const state = NodePath.join(home, "userdata");
    const source = NodePath.join(home, "bb.sqlite");
    const target = NodePath.join(state, "pipeline.sqlite");
    const models = NodePath.join(home, "models.json");
    NodeFS.mkdirSync(state);
    NodeFS.writeFileSync(NodePath.join(state, "environment-id"), "history");
    NodeFS.writeFileSync(models, "{}");
    {
      using db = new NodeSqlite.DatabaseSync(NodePath.join(state, "statev2.sqlite"));
      db.exec(`CREATE TABLE orchestration_v2_projection_threads (
        thread_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, deleted_at TEXT
      )`);
      const insert = db.prepare(
        "INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, NULL)",
      );
      insert.run(bbThreadId("lead"), JSON.stringify({ historyOrigin: "bb_import" }));
      insert.run(bbThreadId("native"), JSON.stringify({ historyOrigin: "native" }));
    }
    {
      using db = new NodeSqlite.DatabaseSync(source);
      db.exec(`
        CREATE TABLE cards (id TEXT, project_id TEXT, title TEXT, "column" TEXT,
          lead_thread_id TEXT, created_at INTEGER, updated_at INTEGER);
        CREATE TABLE card_history (id INTEGER, card_id TEXT);
        CREATE TABLE review_records (card_id TEXT, record TEXT, warnings TEXT);
        CREATE TABLE instruction_snapshots (card_id TEXT, snapshot TEXT);
        INSERT INTO cards VALUES ('c1', 'project', 'Imported', 'reviewing', 'lead', 1, 1);
        INSERT INTO cards VALUES ('c2', 'project', 'Native lookalike', 'reviewing', 'native', 1, 1);
      `);
    }
    expect(importBbPipeline(source, target, home, models)).toMatchObject({
      cards: 2,
      leadLinks: 1,
    });
    expect(importBbPipeline(source, target, home, models)).toMatchObject({ cards: 0, skipped: 2 });
    using db = new NodeSqlite.DatabaseSync(target, { readOnly: true });
    expect(db.prepare("SELECT project_id, lead_thread_id FROM cards ORDER BY title").all()).toEqual(
      [
        { project_id: bbProjectId("project"), lead_thread_id: bbThreadId("lead") },
        { project_id: bbProjectId("project"), lead_thread_id: null },
      ],
    );
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
});
