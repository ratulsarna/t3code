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
const RunState = Schema.Literals(["running", "pause_requested", "pausing", "paused", "stopping"]);
const Mode = Schema.Literals(["manual", "auto", "full-auto"]);
const Size = Schema.Literals(["small", "standard"]);
const Attention = Schema.NullOr(Schema.String.check(Schema.isMaxLength(1000)));
const CardId = Schema.String.check(Schema.isPattern(/^[0-9a-f-]{36}$/));
const TargetFields = { hostId: EnvironmentId, projectId: ProjectId };
const TaskLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32 }));

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
]);
export type PipelineMutation = typeof Mutation.Type;

const Target = Schema.Struct({
  ...TargetFields,
  title: Schema.String,
  hostLabel: Schema.String,
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
  HttpApiEndpoint.post("mutate", "/api/fork/pipeline", {
    payload: Mutation,
    success: Schema.Struct({ id: Schema.NullOr(CardId) }),
    headers,
    error: errors,
  }),
);
