export const pipelineSchema = [
  `CREATE TABLE cards (
     id TEXT PRIMARY KEY, project_id TEXT NOT NULL, host_id TEXT NOT NULL,
     title TEXT NOT NULL, body TEXT NOT NULL, base_ref TEXT NOT NULL, lead_execution TEXT,
     mode TEXT NOT NULL, size TEXT NOT NULL, shape_review INTEGER NOT NULL,
     "column" TEXT NOT NULL, run_state TEXT NOT NULL, start_requested INTEGER NOT NULL,
     lead_thread_id TEXT, attention_reason TEXT, result TEXT, launch_error TEXT, control_error TEXT,
     queued_at INTEGER, occupies_slot INTEGER NOT NULL DEFAULT 0,
     operation TEXT, operation_id TEXT, link_identity TEXT,
     revision INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
   ) STRICT;
   CREATE INDEX cards_queue ON cards(project_id, host_id, occupies_slot, queued_at);
   CREATE TABLE card_history (
     id INTEGER PRIMARY KEY, card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
     at INTEGER NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL,
     from_column TEXT, to_column TEXT, thread_id TEXT, note TEXT
   ) STRICT;
   CREATE INDEX history_card ON card_history(card_id, id);
   CREATE TABLE instruction_snapshots (
     card_id TEXT PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
     snapshot TEXT NOT NULL, report_token TEXT NOT NULL, callback_origin TEXT NOT NULL
   ) STRICT;
   CREATE TABLE task_limits (
     project_id TEXT NOT NULL, host_id TEXT NOT NULL, task_limit INTEGER NOT NULL CHECK(task_limit BETWEEN 1 AND 32),
     PRIMARY KEY(project_id, host_id)
   ) STRICT;
   CREATE TABLE run_next (
     project_id TEXT NOT NULL, host_id TEXT NOT NULL,
     card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
     PRIMARY KEY(project_id, host_id)
   ) STRICT;`,
  `ALTER TABLE cards ADD COLUMN github_repository TEXT;
   ALTER TABLE cards ADD COLUMN issue_url TEXT;
   ALTER TABLE cards ADD COLUMN issue_snapshot TEXT;
   ALTER TABLE cards ADD COLUMN review_ready INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE cards ADD COLUMN pr_url TEXT;
   ALTER TABLE cards ADD COLUMN github_state TEXT;
   ALTER TABLE cards ADD COLUMN retired INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE cards ADD COLUMN historical INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE cards ADD COLUMN lead_environment_id TEXT;
   ALTER TABLE cards ADD COLUMN import_branch TEXT;
   ALTER TABLE cards ADD COLUMN issue_refreshed INTEGER NOT NULL DEFAULT 0;
   CREATE UNIQUE INDEX cards_issue ON cards(project_id, host_id, lower(issue_url)) WHERE issue_url IS NOT NULL AND (historical = 0 OR github_repository IS NOT NULL);
   CREATE TABLE legacy_cards (card_id TEXT PRIMARY KEY REFERENCES cards(id), source_id TEXT NOT NULL UNIQUE, record TEXT NOT NULL, resume_target TEXT);
   CREATE TABLE review_records (card_id TEXT PRIMARY KEY REFERENCES cards(id), record TEXT NOT NULL, warnings TEXT NOT NULL);
   CREATE TABLE reviewer_models (id INTEGER PRIMARY KEY CHECK(id = 1), config TEXT NOT NULL);
   CREATE TABLE pipeline_settings (id INTEGER PRIMARY KEY CHECK(id = 1), lead_selection TEXT NOT NULL);
   CREATE TABLE imported_thread_links (card_id TEXT REFERENCES cards(id), thread_id TEXT NOT NULL,
     PRIMARY KEY(card_id, thread_id));`,
] as const;
