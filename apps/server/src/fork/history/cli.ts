import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";

import { resolveCliAuthConfig } from "../../cli/config.ts";
import { ServerConfig } from "../../config.ts";

export const bbHistoryCommand = Command.make("bb-history", {
  file: Argument.String("jsonl"),
  baseDir: Flag.String("scratch-home"),
  attachmentRoot: Flag.String("attachment-root"),
  workspaceMapFile: Flag.String("workspace-map").pipe(Flag.optional),
  threadWorkspaceMapFile: Flag.String("thread-workspace-map").pipe(
    Flag.withDescription(
      "JSON object mapping bb thread IDs to absolute paths, or null to use the recorded environment path.",
    ),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Import decoded bb history into an offline T3 Code data directory."),
  Command.withHandler(
    Effect.fn(function* ({
      file,
      baseDir,
      attachmentRoot,
      workspaceMapFile,
      threadWorkspaceMapFile,
    }) {
      const config = yield* resolveCliAuthConfig(
        { baseDir: Option.some(baseDir) },
        yield* GlobalFlag.LogLevel,
      );
      const { importHistory } = yield* Effect.promise(() => import("./import.ts"));
      yield* importHistory({
        file,
        attachmentRoot,
        workspaceMapFile: Option.getOrUndefined(workspaceMapFile),
        threadWorkspaceMapFile: Option.getOrUndefined(threadWorkspaceMapFile),
      }).pipe(Effect.provideService(ServerConfig, config));
    }),
  ),
);
