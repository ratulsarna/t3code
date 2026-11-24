import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import type { Kind } from "./tree.ts";

type MemoryRecord = { kind: Kind; text: string };

function tool(toolName: string, input: unknown, output: unknown): MemoryRecord[] {
  return [
    {
      kind: "tool",
      text: `${toolName}: ${typeof input === "string" ? input : JSON.stringify(input)}`,
    },
    ...(output === undefined
      ? []
      : [
          {
            kind: "echo" as const,
            text: typeof output === "string" ? output : JSON.stringify(output),
          },
        ]),
  ];
}

const RECALL = /^(?:"[^"]+"|'[^']+'|\S+) (?:recall|date) [0-9]+(?: [0-9]+)?$/;

export function memoryRecords(event: OrchestrationV2DomainEvent) {
  switch (event.type) {
    case "message.updated": {
      const message = event.payload;
      if (
        message.streaming ||
        message.idleCompaction ||
        message.workflowScript ||
        message.role === "system" ||
        !message.text.trim() ||
        (message.role === "user" && /^\/(?:compact|clear)(?:\s|$)/.test(message.text.trim()))
      )
        return;
      const kind =
        message.role === "assistant"
          ? "unii"
          : message.notification ||
              message.senderThreadId ||
              message.linkedSender ||
              message.scheduledTaskId
            ? "work"
            : "user";
      return {
        key: `message:${message.id}`,
        records: [{ kind, text: message.text }] satisfies MemoryRecord[],
      };
    }
    case "turn-item.updated": {
      const item = event.payload;
      if (
        item.status !== "completed" &&
        item.status !== "failed" &&
        item.status !== "cancelled" &&
        item.status !== "interrupted"
      )
        return;
      let records: MemoryRecord[];
      switch (item.type) {
        case "command_execution":
          if (
            item.status === "completed" &&
            !item.outputIndicatesFailure &&
            RECALL.test(item.input.trim()) &&
            item.input.includes("/.claude/hooks/t3-bot-memory")
          )
            return;
          records = tool("command", item.input, item.output);
          break;
        case "dynamic_tool":
          records = tool(item.toolName ?? "tool", item.input, item.output);
          break;
        case "file_change":
          records = tool("file change", item.fileName, item.diffStr ?? item.changes);
          break;
        case "file_search":
          records = tool("file search", item.pattern, item.results);
          break;
        case "web_search":
          records = tool("web search", item.patterns, item.results);
          break;
        case "subagent":
          records = tool("subagent", item.prompt, item.result ?? undefined);
          break;
        default:
          return;
      }
      return { key: `item:${item.id}`, records };
    }
    default:
      return;
  }
}
