import * as Schema from "effect/Schema";

class BotMemoryError extends Schema.TaggedError<BotMemoryError>()("BotMemoryError", {
  cause: Schema.Defect(),
  message: Schema.String,
}) {}

export function botMemoryError(cause: unknown) {
  return new BotMemoryError({
    cause,
    message: cause instanceof Error ? cause.message : String(cause),
  });
}
