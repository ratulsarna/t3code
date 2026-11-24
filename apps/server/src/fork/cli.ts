import { bbHistoryCommand } from "./history/cli.ts";
import { botsCommand } from "./bots/cli.ts";
import { voiceCommand } from "./agent-tools/voice.ts";

export const forkCommands = {
  group: "Fork commands",
  commands: [bbHistoryCommand, botsCommand, voiceCommand],
} as const;
