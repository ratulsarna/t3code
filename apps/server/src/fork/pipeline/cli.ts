import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Argument, Command } from "effect/cli";

const importCommand = Command.make("import-bb", {
  snapshot: Argument.String("bb-snapshot"),
  target: Argument.String("pipeline-sqlite"),
  historyHome: Argument.String("history-home"),
  models: Argument.String("reviewer-models-json"),
  resumeTargets: Argument.String("resume-targets-json").pipe(Argument.optional),
  leadSettings: Argument.String("bb-lead-settings-json").pipe(Argument.optional),
}).pipe(
  Command.withDescription("Import Pipeline cards from an offline bb snapshot into a stopped T3 home's database."),
  Command.withHandler(
    Effect.fn(function* ({ snapshot, target, historyHome, models, resumeTargets, leadSettings }) {
      const { importBbPipeline } = yield* Effect.promise(() => import("./importBb.ts"));
      const counts = yield* Effect.try(() =>
        importBbPipeline(
          snapshot,
          target,
          historyHome,
          models,
          Option.getOrUndefined(resumeTargets),
          Option.getOrUndefined(leadSettings),
        ),
      );
      yield* Console.log(JSON.stringify(counts));
    }),
  ),
);

export const pipelineCommand = Command.make("pipeline").pipe(
  Command.withSubcommands([importCommand]),
);
