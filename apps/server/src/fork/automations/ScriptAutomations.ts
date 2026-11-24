// @effect-diagnostics nodeBuiltinImport:off -- SQLite transactions run synchronously alongside Pipeline.
import * as NodeSqlite from "node:sqlite";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../../config.ts";
import { ProcessRunner, type ProcessRunOutput } from "../../processRunner.ts";
import { Scheduler } from "../../scheduling/Scheduler.ts";
import { forkDatabaseFilename, migrateForkDatabase, withForkTransaction } from "../migrations.ts";
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

const install = Effect.fn("ScriptAutomations.install")(function* (
  filename: string,
  jobs: readonly Job[],
) {
  const db = yield* Effect.acquireRelease(
    Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
    (connection) => Effect.sync(() => connection.close()),
  );
  yield* Effect.sync(() => migrateForkDatabase(db));
  const scheduler = yield* Scheduler;
  const process = yield* ProcessRunner;

  const bootedAt = yield* Clock.currentTimeMillis;
  const ids = yield* encodeIds(jobs.map(({ id }) => id));
  yield* Effect.sync(() =>
    withForkTransaction(db, () => {
      db.exec(`UPDATE script_schedules SET failures = 0 WHERE id IN (
        SELECT job_id FROM script_runs WHERE status = 'running'
      )`);
      db.prepare(`UPDATE script_runs
        SET status = 'skipped', finished_at = ?,
          reason = 'interrupted: server restarted before the script result was recorded'
        WHERE status = 'running'`).run(bootedAt);
      db.prepare(`UPDATE script_schedules SET next_run_at = NULL, failures = 0
        WHERE id NOT IN (SELECT value FROM json_each(?))`).run(ids);
      const save = db.prepare(`INSERT INTO script_schedules (id, cron, timezone, next_run_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          cron = excluded.cron, timezone = excluded.timezone,
          next_run_at = excluded.next_run_at, failures = 0
        WHERE script_schedules.cron <> excluded.cron
           OR script_schedules.timezone <> excluded.timezone
           OR (script_schedules.next_run_at IS NULL) <> (excluded.next_run_at IS NULL)`);
      for (const job of jobs) {
        save.run(job.id, job.cron, job.timezone, job.enabled ? nextRunAt(job, bootedAt) : null);
      }
    }),
  );
  const findDue = db.prepare(`SELECT next_run_at, failures FROM script_schedules
    WHERE id = ? AND next_run_at <= ?
      AND NOT EXISTS (SELECT 1 FROM script_runs WHERE job_id = ? AND status = 'running')`);
  const advance = db.prepare("UPDATE script_schedules SET next_run_at = ? WHERE id = ?");
  const claimRun = db.prepare(`INSERT INTO script_runs (job_id, due_at, started_at, status)
    VALUES (?, ?, ?, 'running') ON CONFLICT(job_id, due_at) DO NOTHING`);
  const completeRun = db.prepare(`UPDATE script_runs SET status = ?, finished_at = ?,
    output = ?, exit_code = ?, reason = ? WHERE job_id = ? AND due_at = ? AND status = 'running'`);
  const retry = db.prepare(`UPDATE script_schedules SET failures = ?,
    next_run_at = MIN(next_run_at, COALESCE(?, next_run_at)) WHERE id = ?`);

  const runDue = (job: Job) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const claim = yield* Effect.sync(() =>
          withForkTransaction(db, () => {
            const due = findDue.get(job.id, now, job.id) as
              | { next_run_at: number; failures: number }
              | undefined;
            if (!due) return null;
            advance.run(nextRunAt(job, now), job.id);
            return claimRun.run(job.id, due.next_run_at, now).changes === 0 ? null : due;
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
        yield* Effect.sync(() =>
          withForkTransaction(db, () => {
            completeRun.run(
              outcome.status,
              finishedAt,
              outcome.output,
              outcome.code,
              outcome.reason,
              job.id,
              claim.next_run_at,
            );
            retry.run(failures, retryAt, job.id);
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
    return Layer.effectDiscard(install(path.join(config.stateDir, forkDatabaseFilename), jobs));
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
