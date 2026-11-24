import * as Schema from "effect/Schema";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";

import { EnvironmentId, ProjectId, ThreadId } from "../../baseSchemas.ts";
import { ModelSelection } from "../../modelSelection.ts";

export const PIPELINE_COLUMNS = [
  "backlog",
  "todo",
  "planning",
  "plan_ready",
  "implementing",
  "reviewing",
  "qa",
  "pr",
  "pr_ready",
  "done",
] as const;

export const PIPELINE_COLUMN_LABELS: Record<(typeof PIPELINE_COLUMNS)[number], string> = {
  backlog: "Backlog",
  todo: "To do",
  planning: "Planning",
  plan_ready: "Plan ready",
  implementing: "Implementing",
  reviewing: "Reviewing",
  qa: "QA",
  pr: "PR",
  pr_ready: "PR ready",
  done: "Done",
};

const Column = Schema.Literals(PIPELINE_COLUMNS);
export type PipelineColumn = typeof Column.Type;
const RunState = Schema.Literals(["running", "pause_requested", "pausing", "paused", "stopping"]);
const Mode = Schema.Literals(["manual", "auto", "full-auto"]);
const Size = Schema.Literals(["small", "standard"]);
const Attention = Schema.NullOr(Schema.String.check(Schema.isMaxLength(1000)));
const CardId = Schema.String.check(Schema.isPattern(/^[0-9a-f-]{36}$/));
const TargetFields = { hostId: EnvironmentId, projectId: ProjectId };
const TaskLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32 }));

const IssueUrl = Schema.String.check(Schema.isMaxLength(500));
const ReviewState = Schema.Literals(["waiting", "feedback", "clear", "unknown"]);
const PrStatus = Schema.Struct({
  url: Schema.String,
  state: Schema.Literals(["open", "closed", "merged"]),
  draft: Schema.Boolean,
  headSha: Schema.String,
  checks: Schema.Array(Schema.Struct({ name: Schema.String, state: Schema.String })),
  review: ReviewState,
  batchId: Schema.NullOr(Schema.String),
  pendingFeedback: Schema.Array(
    Schema.Struct({ id: Schema.String, author: Schema.String, url: Schema.String }),
  ),
  manualReviewPending: Schema.optionalKey(Schema.Boolean),
  error: Schema.NullOr(Schema.String),
});
const IssueSummary = Schema.Struct({
  url: IssueUrl,
  number: Schema.Int,
  title: Schema.String,
  state: Schema.Literals(["open", "closed"]),
  labels: Schema.Array(Schema.String),
  assignees: Schema.Array(Schema.String),
  updatedAt: Schema.String,
});
const StatsRange = Schema.Literals(["7", "30", "90", "all"]);
export type PipelineStatsRange = typeof StatsRange.Type;
const Stats = Schema.Struct({
  finished: Schema.Int,
  inProgress: Schema.Int,
  startToDoneMs: Schema.NullOr(Schema.Number),
  stages: Schema.Array(
    Schema.Struct({
      column: Column,
      workingMs: Schema.Number,
      waitingMs: Schema.Number,
      reviewMs: Schema.Number,
      pausedMs: Schema.Number,
    }),
  ),
  bounces: Schema.Struct({
    review: Schema.Int,
    qa: Schema.Int,
    external: Schema.Int,
    perCard: Schema.NullOr(Schema.Number),
    top: Schema.Array(
      Schema.Struct({
        cardId: Schema.String,
        title: Schema.String,
        leadThreadId: Schema.NullOr(Schema.String),
        review: Schema.Int,
        qa: Schema.Int,
        external: Schema.Int,
      }),
    ),
  }),
  reasons: Schema.Array(
    Schema.Struct({ reason: Schema.String, count: Schema.Int, waitingMs: Schema.Number }),
  ),
});
export type PipelineStats = typeof Stats.Type;

export const PipelineNewCard = Schema.Struct({
  ...TargetFields,
  title: Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  body: Schema.String.check(Schema.isMaxLength(20_000)),
  baseRef: Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(250)),
  lead: Schema.optionalKey(ModelSelection),
  mode: Mode,
  size: Size,
  shapeReview: Schema.Boolean,
  start: Schema.Boolean,
  issueUrl: Schema.optionalKey(IssueUrl),
});
export type PipelineNewCard = typeof PipelineNewCard.Type;

export const PipelineCard = Schema.Struct({
  ...TargetFields,
  id: CardId,
  title: Schema.String,
  body: Schema.String,
  baseRef: Schema.String,
  mode: Mode,
  size: Size,
  shapeReview: Schema.Boolean,
  column: Column,
  runState: RunState,
  startRequested: Schema.Boolean,
  leadThreadId: Schema.NullOr(ThreadId),
  leadEnvironmentId: Schema.NullOr(EnvironmentId),
  historical: Schema.Boolean,
  issueUrl: Schema.NullOr(IssueUrl),
  pullRequest: Schema.NullOr(PrStatus),
  worktreeRetired: Schema.Boolean,
  attentionReason: Attention,
  result: Schema.NullOr(Schema.String),
  launchError: Schema.NullOr(Schema.String),
  controlError: Schema.NullOr(Schema.String),
  waitingReason: Schema.NullOr(Schema.String),
  runNext: Schema.Boolean,
  occupiesSlot: Schema.Boolean,
  revision: Schema.Int,
});
export type PipelineCard = typeof PipelineCard.Type;

export const PipelineReport = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("status"),
    column: Schema.optionalKey(
      Schema.Literals([
        "planning",
        "plan_ready",
        "implementing",
        "reviewing",
        "qa",
        "pr",
        "pr_ready",
        "done",
      ]),
    ),
    needsYou: Schema.optionalKey(Attention),
    result: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4000))),
  }),
  Schema.Struct({ kind: Schema.Literal("paused"), requestId: CardId }),
  Schema.Struct({ kind: Schema.Literal("pull_request"), url: IssueUrl }),
  Schema.Struct({
    kind: Schema.Literal("review_wait"),
    handled: Schema.optionalKey(Schema.String),
  }),
]);
export type PipelineReport = typeof PipelineReport.Type;

const cardAction = <const Kind extends string>(kind: Kind) =>
  Schema.Struct({ kind: Schema.Literal(kind), id: CardId });

const Mutation = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("create"), card: PipelineNewCard }),
  Schema.Struct({ kind: Schema.Literal("limit"), ...TargetFields, limit: TaskLimit }),
  Schema.Struct({ kind: Schema.Literal("move"), id: CardId, column: Column }),
  cardAction("start"),
  cardAction("retry"),
  cardAction("pause"),
  cardAction("stop"),
  cardAction("resume"),
  cardAction("run_next"),
  cardAction("clear_run_next"),
  cardAction("send_review"),
  cardAction("refresh_github"),
]);
export type PipelineMutation = typeof Mutation.Type;

const Target = Schema.Struct({
  ...TargetFields,
  title: Schema.String,
  hostLabel: Schema.String,
  githubRepository: Schema.NullOr(Schema.String),
});
const Board = Schema.Struct({
  enabled: Schema.Boolean,
  hosts: Schema.Array(Schema.Struct({ id: EnvironmentId, label: Schema.String })),
  cards: Schema.Array(PipelineCard),
  limits: Schema.Array(Schema.Struct({ ...TargetFields, limit: TaskLimit })),
});
export type PipelineBoard = typeof Board.Type;
export const PIPELINE_DEFAULT_LIMIT = 2;

export class PipelineFailure extends Schema.TaggedError<PipelineFailure>()(
  "PipelineFailure",
  {
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {}

export class PipelineScopeRequired extends Schema.TaggedError<PipelineScopeRequired>()(
  "PipelineScopeRequired",
  {
    message: Schema.String,
  },
  { httpApiStatus: 403 },
) {}

const headers = Schema.Struct({
  authorization: Schema.optionalKey(Schema.String),
  dpop: Schema.optionalKey(Schema.String),
});
const errors = [PipelineFailure, PipelineScopeRequired];

export const PipelineHttpGroup = HttpApiGroup.make("pipeline").add(
  HttpApiEndpoint.get("board", "/api/fork/pipeline", { headers, success: Board, error: errors }),
  HttpApiEndpoint.get("projects", "/api/fork/pipeline/projects", {
    query: { hostId: EnvironmentId },
    success: Schema.Array(Target),
    headers,
    error: errors,
  }),
  HttpApiEndpoint.get("issues", "/api/fork/pipeline/issues", {
    query: { ...TargetFields },
    success: Schema.Array(IssueSummary),
    headers,
    error: errors,
  }),
  HttpApiEndpoint.get("stats", "/api/fork/pipeline/stats", {
    query: { ...TargetFields, range: StatsRange },
    success: Stats,
    headers,
    error: errors,
  }),
  HttpApiEndpoint.post("mutate", "/api/fork/pipeline", {
    payload: Mutation,
    success: Schema.Struct({ id: Schema.NullOr(CardId) }),
    headers,
    error: errors,
  }),
);
