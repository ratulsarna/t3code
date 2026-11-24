// @effect-diagnostics nodeBuiltinImport:off -- Summary subprocesses run in an empty host directory.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { botMemoryError } from "./error.ts";
import { ServerConfig } from "../../config.ts";
import { EventSinkV2 } from "../../orchestration-v2/EventSink.ts";
import { readBotsConfig, readCursor, writeCursor } from "./config.ts";
import { localIso } from "./history.ts";
import { memoryRecords } from "./records.ts";
import { Summarizer } from "./summarize.ts";
import { Chat } from "./tree.ts";

export const botMemoryLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig;
    const { bots, summaries } = readBotsConfig(stateDir);
    if (bots.length === 0) return;
    const sink = yield* EventSinkV2;
    const scratch = yield* Effect.acquireRelease(
      Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(stateDir, "bot-summary-"))),
      (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
    );
    const summarizer = yield* Effect.acquireRelease(
      Effect.sync(() => new Summarizer(scratch, summaries)),
      (runner) => Effect.sync(() => runner.dispose()),
    );
    for (const bot of bots) {
      const tail = Effect.gen(function* () {
        const chat = yield* Effect.acquireRelease(
          Effect.try({ try: () => Chat.open(bot.memoryDir), catch: botMemoryError }),
          (chat) => Effect.promise(() => chat.close()),
        );
        if (summaries !== undefined) chat.tune(summaries);
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            summarizer.add(bot.id, chat);
            summarizer.pump();
          }),
          () => Effect.sync(() => summarizer.remove(chat)),
        );
        const afterSequence = yield* Effect.try({
          try: () => readCursor(bot),
          catch: botMemoryError,
        });
        yield* sink.stream({ threadId: bot.threadId, afterSequence }).pipe(
          Stream.runForEach(({ event, sequence }) =>
            Effect.tryPromise({
              try: async () => {
                const entry = memoryRecords(event);
                if (entry === undefined) return;
                // The event cursor can lag a flushed append. A stable item key also handles repeated updates.
                const source = { stream: `t3:${bot.threadId}:${entry.key}`, at: 0, n: 0 };
                const date = localIso(DateTime.toEpochMillis(event.occurredAt));
                for (const record of entry.records)
                  chat.append(record.kind, record.text, date, source);
                await chat.flush();
                writeCursor(bot, sequence);
                summarizer.pump();
              },
              catch: botMemoryError,
            }).pipe(Effect.uninterruptible),
          ),
          Effect.mapError(botMemoryError),
        );
      }).pipe(
        Effect.scoped,
        Effect.tapError((cause) =>
          Effect.logWarning("Bot memory writer will retry", { bot: bot.id, cause }),
        ),
        Effect.retry(Schedule.spaced("5 seconds")),
      );
      yield* Effect.forkScoped(tail);
    }
  }),
);
