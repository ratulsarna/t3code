import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Argument, Command } from "effect/cli";
import { botMemoryError } from "./error.ts";

const stateDir = Argument.String("state-dir");

export const botsCommand = Command.make("bots").pipe(
  Command.withSubcommands([
    Command.make("install", { stateDir }).pipe(
      Command.withDescription("Install the configured bots' Claude hooks in their homes."),
      Command.withHandler(({ stateDir }) =>
        Effect.promise(() => import("./hook.ts")).pipe(
          Effect.flatMap(({ installHooks }) =>
            Effect.try({ try: () => installHooks(stateDir), catch: botMemoryError }),
          ),
        ),
      ),
    ),
    Command.make("session-start", { stateDir }).pipe(
      Command.unlisted,
      Command.withHandler(({ stateDir }) =>
        Effect.promise(() => import("./hook.ts")).pipe(
          Effect.flatMap(({ sessionStart }) =>
            Effect.try({ try: () => sessionStart(stateDir), catch: botMemoryError }),
          ),
        ),
      ),
    ),
    Command.make("recall", {
      stateDir,
      id: Argument.Int("id"),
      span: Argument.Int("span").pipe(Argument.optional),
    }).pipe(
      Command.withHandler(({ stateDir, id, span }) =>
        Effect.promise(() => import("./hook.ts")).pipe(
          Effect.flatMap(({ recall }) =>
            Effect.try({
              try: () =>
                recall(
                  stateDir,
                  id,
                  Option.getOrElse(span, () => 1),
                ),
              catch: botMemoryError,
            }),
          ),
        ),
      ),
    ),
    Command.make("date", { stateDir, id: Argument.Int("id") }).pipe(
      Command.withHandler(({ stateDir, id }) =>
        Effect.promise(() => import("./hook.ts")).pipe(
          Effect.flatMap(({ recall }) =>
            Effect.try({ try: () => recall(stateDir, id, undefined), catch: botMemoryError }),
          ),
        ),
      ),
    ),
  ]),
);
