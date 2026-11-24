import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { ProcessRunner, type ProcessRunOutput } from "../../processRunner.ts";
import { Scheduler } from "../../scheduling/Scheduler.ts";
import { nextRunAt, validateSchedule } from "./Schedule.ts";

const CONFIG_FILE = "script-automations.json";
const MAX_OUTPUT_BYTES = 1024 * 1024;
const RETRY_DELAYS_MS = [30_000, 60_000];

const Job = Schema.Struct({
  id: Schema.NonEmptyString,
  enabled: Schema.Boolean,
  cron: Schema.NonEmptyString,
  timezone: Schema.NonEmptyString,
  interpreter: Schema.NonEmptyString,
  script: Schema.NonEmptyString,
  cwd: Schema.NonEmptyString,
  args: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  timeoutMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 900_000 })),
});
type Job = typeof Job.Type;
const decodeJobs = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Job)));
const encodeIds = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));

class InvalidScriptConfig extends Schema.TaggedError<
  InvalidScriptConfig,
  { readonly brand: unique symbol }
>()("InvalidScriptConfig", { reason: Schema.String }) {}
const isInvalidScriptConfig = Schema.is(InvalidScriptConfig);

const isSilent = (output: string): boolean => {
  const lastLine = output.trimEnd().split("\n").at(-1)?.trim();
  if (!lastLine) return true;
  try {
    return (JSON.parse(lastLine) as { wakeAgent?: unknown } | null)?.wakeAgent === false;
  } catch {
    return false;
  }
};

function classify(result: ProcessRunOutput) {
  const { code, stdout, stderr } = result;
  const output = stdout + stderr;
  if (result.timedOut) {
    return { status: "failed", output, code, reason: "Script timed out." };
  }
  if (code !== 0) {
    return { status: "failed", output, code, reason: `Script exited with status ${code}.` };
  }
  if (isSilent(output)) {
    return {
      status: "skipped",
      output: null,
      code,
      reason: output.trim() ? "wakeAgent false" : "empty output",
    };
  }
  return { status: "succeeded", output, code, reason: null };
}

const install = Effect.fn("ScriptAutomations.install")(function* (jobs: readonly Job[]) {
  const sql = yield* SqlClient.SqlClient;
  const scheduler = yield* Scheduler;
  const process = yield* ProcessRunner;

  yield* sql`CREATE TABLE IF NOT EXISTS script_schedules (
      id TEXT PRIMARY KEY,
      cron TEXT NOT NULL,
      timezone TEXT NOT NULL,
      next_run_at INTEGER,
      failures INTEGER NOT NULL DEFAULT 0
    )`;
  yield* sql`CREATE TABLE IF NOT EXISTS script_runs (
      job_id TEXT NOT NULL REFERENCES script_schedules(id),
      due_at INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      status TEXT NOT NULL,
      output TEXT,
      exit_code INTEGER,
      reason TEXT,
      PRIMARY KEY (job_id, due_at)
    )`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS script_runs_single_flight
      ON script_runs (job_id) WHERE status = 'running'`;

  const bootedAt = yield* Clock.currentTimeMillis;
  const ids = yield* encodeIds(jobs.map(({ id }) => id));
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`UPDATE script_schedules SET failures = 0 WHERE id IN (
        SELECT job_id FROM script_runs WHERE status = 'running'
      )`;
      yield* sql`UPDATE script_runs
        SET status = 'skipped', finished_at = ${bootedAt},
          reason = 'interrupted: server restarted before the script result was recorded'
        WHERE status = 'running'`;
      yield* sql`UPDATE script_schedules SET next_run_at = NULL, failures = 0
        WHERE id NOT IN (SELECT value FROM json_each(${ids}))`;
      for (const job of jobs) {
        const next = job.enabled ? nextRunAt(job, bootedAt) : null;
        yield* sql`INSERT INTO script_schedules (id, cron, timezone, next_run_at)
          VALUES (${job.id}, ${job.cron}, ${job.timezone}, ${next})
          ON CONFLICT(id) DO UPDATE SET
            cron = excluded.cron, timezone = excluded.timezone,
            next_run_at = excluded.next_run_at, failures = 0
          WHERE script_schedules.cron <> excluded.cron
             OR script_schedules.timezone <> excluded.timezone
             OR (script_schedules.next_run_at IS NULL) <> (excluded.next_run_at IS NULL)`;
      }
    }),
  );

  const runDue = (job: Job) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const claim = yield* sql.withTransaction(
          Effect.gen(function* () {
            const [due] = yield* sql<{ next_run_at: number; failures: number }>`
              SELECT next_run_at, failures FROM script_schedules
              WHERE id = ${job.id} AND next_run_at <= ${now}
                AND NOT EXISTS (SELECT 1 FROM script_runs WHERE job_id = ${job.id} AND status = 'running')`;
            if (!due) return null;
            yield* sql`UPDATE script_schedules
              SET next_run_at = ${nextRunAt(job, now)} WHERE id = ${job.id}`;
            const [run] = yield* sql`INSERT INTO script_runs (job_id, due_at, started_at, status)
              VALUES (${job.id}, ${due.next_run_at}, ${now}, 'running')
              ON CONFLICT(job_id, due_at) DO NOTHING RETURNING job_id`;
            return run ? due : null;
          }),
        );
        if (!claim) return;

        const result = yield* restore(
          process.run({
            command: job.interpreter,
            args: [job.script, ...(job.args ?? [])],
            cwd: job.cwd,
            env: {
              ...job.env,
              T3CODE_AUTOMATION_ID: job.id,
              T3CODE_AUTOMATION_DUE_AT: DateTime.formatIso(DateTime.makeUnsafe(claim.next_run_at)),
            },
            timeout: job.timeoutMs,
            maxOutputBytes: MAX_OUTPUT_BYTES,
            timeoutBehavior: "timedOutResult",
          }),
        ).pipe(Effect.exit);
        const finishedAt = yield* Clock.currentTimeMillis;
        const outcome =
          result._tag === "Success"
            ? classify(result.value)
            : Cause.hasInterruptsOnly(result.cause)
              ? {
                  status: "skipped",
                  output: null,
                  code: null,
                  reason: "interrupted: server shutdown",
                }
              : {
                  status: "failed",
                  output: null,
                  code: null,
                  reason: Cause.pretty(result.cause),
                };
        const failures = outcome.status === "failed" ? claim.failures + 1 : 0;
        const delay = RETRY_DELAYS_MS[failures - 1];
        const retryAt = delay === undefined ? null : finishedAt + delay;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`UPDATE script_runs SET status = ${outcome.status}, finished_at = ${finishedAt},
              output = ${outcome.output}, exit_code = ${outcome.code}, reason = ${outcome.reason}
              WHERE job_id = ${job.id} AND due_at = ${claim.next_run_at} AND status = 'running'`;
            yield* sql`UPDATE script_schedules SET failures = ${failures},
              next_run_at = MIN(next_run_at, COALESCE(${retryAt}, next_run_at))
              WHERE id = ${job.id}`;
          }),
        );
        if (outcome.status === "failed") {
          yield* Effect.logWarning("Script automation failed", { jobId: job.id });
        }
      }),
    );

  for (const job of jobs) {
    if (job.enabled) yield* scheduler.register(`script-automation:${job.id}`, runDue(job));
  }
});

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const file = path.join(config.baseDir, CONFIG_FILE);
    if (!(yield* fs.exists(file))) return Layer.empty;
    const contents = yield* fs.readFileString(file);
    const jobs = yield* decodeJobs(contents);
    const ids = new Set<string>();
    for (const job of jobs) {
      if (ids.has(job.id) || !path.isAbsolute(job.cwd) || !path.isAbsolute(job.script)) {
        return yield* new InvalidScriptConfig({
          reason: "Expected unique job IDs and absolute paths.",
        });
      }
      yield* Effect.try({
        try: () => validateSchedule(job),
        catch: () =>
          new InvalidScriptConfig({ reason: "Expected a valid cron expression and time zone." }),
      });
      ids.add(job.id);
    }
    return Layer.effectDiscard(install(jobs)).pipe(
      Layer.provide(
        NodeSqliteClient.layer({
          filename: path.join(config.stateDir, "script-automations.sqlite"),
        }),
      ),
    );
  }),
).pipe(
  Layer.catchCause((cause) => {
    const error = Option.getOrUndefined(Cause.findErrorOption(cause));
    return Layer.effectDiscard(
      Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : Effect.logError(
            "Script automations could not start. Check the local script-automations.json and database.",
            isInvalidScriptConfig(error) ? { reason: error.reason } : {},
          ),
    );
  }),
);
