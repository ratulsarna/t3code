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
}).pipe(
  Command.withDescription("Import decoded bb history into an offline T3 Code data directory."),
  Command.withHandler(
    Effect.fn(function* ({ file, baseDir, attachmentRoot, workspaceMapFile }) {
      const config = yield* resolveCliAuthConfig(
        { baseDir: Option.some(baseDir) },
        yield* GlobalFlag.LogLevel,
      );
      const { importHistory } = yield* Effect.promise(() => import("./import.ts"));
      yield* importHistory({
        file,
        attachmentRoot,
        workspaceMapFile: Option.getOrUndefined(workspaceMapFile),
      }).pipe(Effect.provideService(ServerConfig, config));
    }),
  ),
);
