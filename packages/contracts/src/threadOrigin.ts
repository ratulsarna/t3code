import { Schema } from "effect";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas";

export const ThreadOriginKind = Schema.Literals([
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
]);
export type ThreadOriginKind = typeof ThreadOriginKind.Type;

export const ThreadOrigin = Schema.Struct({
  kind: ThreadOriginKind,
  parentProviderThreadId: Schema.optional(TrimmedNonEmptyString),
  depth: Schema.optional(NonNegativeInt),
  agentNickname: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  agentRole: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  otherKind: Schema.optional(TrimmedNonEmptyString),
});
export type ThreadOrigin = typeof ThreadOrigin.Type;
