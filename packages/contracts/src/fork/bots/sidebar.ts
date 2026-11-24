import * as Schema from "effect/Schema";
import { ThreadId } from "../../baseSchemas.ts";

export const BotSidebarEntry = Schema.Struct({
  id: Schema.String,
  threadId: ThreadId,
  name: Schema.String,
  subtitle: Schema.optionalKey(Schema.String),
  avatar: Schema.optionalKey(Schema.String),
});
export type BotSidebarEntry = typeof BotSidebarEntry.Type;
