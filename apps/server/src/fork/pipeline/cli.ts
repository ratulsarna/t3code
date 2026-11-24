import { PipelineFailure } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Argument, Command } from "effect/cli";

const encodeCounts = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const importCommand = Command.make("import-bb", {
  snapshot: Argument.String("bb-snapshot"),
  target: Argument.String("pipeline-sqlite"),
  historyHome: Argument.String("history-home"),
  models: Argument.String("reviewer-models-json"),
  resumeTargets: Argument.String("resume-targets-json").pipe(Argument.optional),
  leadSettings: Argument.String("bb-lead-settings-json").pipe(Argument.optional),
}).pipe(
  Command.withDescription(
    "Import Pipeline cards from an offline bb snapshot into a stopped T3 home's database.",
  ),
  Command.withHandler(
    Effect.fn(function* ({ snapshot, target, historyHome, models, resumeTargets, leadSettings }) {
      const { importBbPipeline } = yield* Effect.promise(() => import("./importBb.ts"));
      const counts = yield* Effect.try({
        try: () =>
          importBbPipeline(
            snapshot,
            target,
            historyHome,
            models,
            Option.getOrUndefined(resumeTargets),
            Option.getOrUndefined(leadSettings),
          ),
        catch: (cause) =>
          new PipelineFailure({ message: cause instanceof Error ? cause.message : String(cause) }),
      });
      yield* Console.log(yield* encodeCounts(counts));
    }),
  ),
);

export const pipelineCommand = Command.make("pipeline").pipe(
  Command.withSubcommands([importCommand]),
);
