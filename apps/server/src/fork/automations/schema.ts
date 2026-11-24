export const scriptAutomationSchema = `
  CREATE TABLE IF NOT EXISTS script_schedules (
      id TEXT PRIMARY KEY,
      cron TEXT NOT NULL,
      timezone TEXT NOT NULL,
      next_run_at INTEGER,
      failures INTEGER NOT NULL DEFAULT 0
    );
  CREATE TABLE IF NOT EXISTS script_runs (
      job_id TEXT NOT NULL REFERENCES script_schedules(id),
      due_at INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      status TEXT NOT NULL,
      output TEXT,
      exit_code INTEGER,
      reason TEXT,
      PRIMARY KEY (job_id, due_at)
    );
  CREATE UNIQUE INDEX IF NOT EXISTS script_runs_single_flight
      ON script_runs (job_id) WHERE status = 'running';
`;
