import {
  AuthOrchestrationOperateScope,
  DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
} from "@t3tools/contracts";
import { encodeSpeechPcmRequest } from "@t3tools/shared/speech";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Argument, Command, GlobalFlag } from "effect/cli";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { authLocationFlags, resolveCliAuthConfig } from "../../cli/config.ts";
import * as RunningServer from "../../cli/runningServer.ts";
import * as ServerConfig from "../../config.ts";
import { readLiveServerRuntimeState } from "../../serverRuntimeState.ts";
import { MAX_SPEECH_BYTES } from "../../speech/SpeechService.ts";

class VoiceMemoError extends Schema.TaggedError<VoiceMemoError>()("VoiceMemoError", {
  detail: Schema.String,
}) {
  override get message() {
    return this.detail;
  }
}

const decodeMemo = Effect.fn("voice.decodeMemo")(
  function* (file: string) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const process = yield* spawner.spawn(
      ChildProcess.make(
        "ffmpeg",
        [
          "-nostdin",
          "-v",
          "error",
          "-protocol_whitelist",
          "file,pipe",
          "-i",
          file,
          "-map",
          "0:a:0",
          "-ac",
          "1",
          "-ar",
          "16000",
          "-f",
          "f32le",
          "pipe:1",
        ],
        { stdin: "ignore", stderr: "ignore" },
      ),
    );
    let length = 0;
    const chunks = yield* Stream.runCollect(
      process.stdout.pipe(
        Stream.mapEffect((chunk) => {
          length += chunk.byteLength;
          return length > MAX_SPEECH_BYTES ? Effect.fail("audio size") : Effect.succeed(chunk);
        }),
      ),
    );
    const code = yield* process.exitCode;
    if (code !== 0 || length === 0) return yield* Effect.fail("empty or invalid audio");
    return Buffer.concat(chunks, length);
  },
  Effect.scoped,
  Effect.timeout("60 seconds"),
  Effect.mapError(
    () =>
      new VoiceMemoError({
        detail:
          "Could not decode the audio. Check the file, ffmpeg installation, and five-minute recording limit.",
      }),
  ),
);

const transcribe = Command.make("transcribe", {
  ...authLocationFlags,
  file: Argument.String("file").pipe(Argument.withDescription("Local audio memo to transcribe.")),
}).pipe(
  Command.withDescription(
    "Transcribe a local audio file with the running T3 host's selected model.",
  ),
  Command.withHandler(
    Effect.fn("voice.transcribeMemo")(function* (flags) {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, logLevel, { quietLogs: true });
      const { serverRuntimeStatePath } = config;
      const running = yield* readLiveServerRuntimeState(serverRuntimeStatePath);
      if (Option.isNone(running)) {
        return yield* new VoiceMemoError({ detail: "Start the selected T3 Code server first." });
      }
      const origin = new URL(running.value.origin);
      if (!["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)) {
        return yield* new VoiceMemoError({
          detail: "Use the T3 server's loopback listener on this host.",
        });
      }

      return yield* Effect.gen(function* () {
        const client = yield* RunningServer.serverClient(origin.href, [
          AuthOrchestrationOperateScope,
        ]);
        const status = yield* client.voice.status({ headers: {} });
        if (!status.supported) {
          return yield* new VoiceMemoError({ detail: status.reason });
        }
        if (status.state === "missing-model") {
          return yield* new VoiceMemoError({
            detail: `The selected host model ${status.model} is missing. Install it in T3 Voice settings.`,
          });
        }

        const fs = yield* FileSystem.FileSystem;
        const file = yield* fs.realPath(flags.file);
        const pcm = yield* decodeMemo(file);
        const { text } = yield* client.voice
          .transcribe({
            headers: {},
            payload: encodeSpeechPcmRequest(pcm, DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS),
          })
          .pipe(Effect.timeout("5 minutes"));
        yield* Console.log(text);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          EnvironmentAuth.layerRuntime.pipe(Layer.provide(ServerConfig.layer(config))),
        ),
      );
    }),
  ),
);

export const voiceCommand = Command.make("voice").pipe(
  Command.withDescription("Use this T3 Code host's voice tools."),
  Command.withSubcommands([transcribe]),
);
