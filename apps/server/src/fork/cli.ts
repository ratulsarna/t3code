import { bbHistoryCommand } from "./history/cli.ts";
import { botsCommand } from "./bots/cli.ts";
import { pipelineCommand } from "./pipeline/cli.ts";
import { voiceCommand } from "./agent-tools/voice.ts";

export const forkCommands = {
  group: "Fork commands",
  commands: [bbHistoryCommand, botsCommand, pipelineCommand, voiceCommand],
} as const;
