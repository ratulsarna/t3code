// @effect-diagnostics nodeBuiltinImport:off -- The server writer and local hook share atomic file access.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { ThreadId } from "@t3tools/contracts";

const Binding = Schema.Struct({
  id: Schema.String,
  threadId: ThreadId,
  name: Schema.String,
  subtitle: Schema.optionalKey(Schema.String),
  home: Schema.String,
  memoryDir: Schema.String,
  afterSequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

const Config = Schema.Struct({
  bots: Schema.Array(Binding),
  summaries: Schema.optionalKey(
    Schema.Struct({
      runner: Schema.Literals(["claude", "pi"]),
      model: Schema.String,
      binary: Schema.optionalKey(Schema.String),
      pool: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
      target: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
      zone: Schema.optionalKey(Schema.String),
    }),
  ),
});

const decodeConfig = Schema.decodeSync(Schema.fromJsonString(Config));

export type BotBinding = typeof Binding.Type;

export function readBotsConfig(stateDir: string): typeof Config.Type {
  const file = NodePath.join(stateDir, "fork-bots.json");
  if (!NodeFS.existsSync(file)) return { bots: [] };
  const config = decodeConfig(NodeFS.readFileSync(file, "utf8"));
  for (const key of ["id", "threadId", "memoryDir"] as const) {
    if (new Set(config.bots.map((bot) => bot[key])).size !== config.bots.length) {
      throw new Error(`Duplicate bot ${key} in ${file}`);
    }
  }
  for (const bot of config.bots) {
    if (!NodePath.isAbsolute(bot.home) || !NodePath.isAbsolute(bot.memoryDir)) {
      throw new Error(`Bot ${bot.id} requires absolute home and memoryDir paths`);
    }
  }
  if (config.summaries?.zone) {
    Intl.DateTimeFormat("en", { timeZone: config.summaries.zone });
  }
  return config;
}

export function sidebarBots(stateDir: string) {
  return readBotsConfig(stateDir).bots.map(({ id, threadId, name, subtitle, home }) => {
    const file = NodePath.join(home, "avatar.svg");
    const stat = NodeFS.statSync(file, { throwIfNoEntry: false });
    const avatar =
      stat?.isFile() && stat.size <= 32_768
        ? `data:image/svg+xml;base64,${NodeFS.readFileSync(file).toString("base64")}`
        : undefined;
    return {
      id,
      threadId,
      name,
      ...(subtitle === undefined ? {} : { subtitle }),
      ...(avatar === undefined ? {} : { avatar }),
    };
  });
}

const cursorPath = (bot: BotBinding) => NodePath.join(bot.memoryDir, "t3-cursor.json");
const Cursor = Schema.Struct({
  threadId: ThreadId,
  sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

const decodeCursor = Schema.decodeSync(Schema.fromJsonString(Cursor));

export function readCursor(bot: BotBinding): number {
  const file = cursorPath(bot);
  if (!NodeFS.existsSync(file)) return bot.afterSequence;
  const cursor = decodeCursor(NodeFS.readFileSync(file, "utf8"));
  if (cursor.threadId !== bot.threadId || cursor.sequence < bot.afterSequence) {
    throw new Error(`Memory cursor does not match the binding for ${bot.id}`);
  }
  return cursor.sequence;
}

export function writeCursor(bot: BotBinding, sequence: number): void {
  atomicWrite(cursorPath(bot), JSON.stringify({ threadId: bot.threadId, sequence }));
}

export function atomicWrite(file: string, value: string): void {
  const pending = `${file}.${process.pid}.tmp`;
  NodeFS.writeFileSync(pending, value, { mode: 0o600, flush: true });
  NodeFS.renameSync(pending, file);
}

export const encodePruneCursors = (bots: readonly BotBinding[]) =>
  JSON.stringify(bots.map((bot) => [bot.threadId, readCursor(bot)]));
