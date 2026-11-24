// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Claude invokes this local file reader outside the running server.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSea from "node:sea";
import * as NodeSqlite from "node:sqlite";
import { bbThreadId } from "../history/ids.ts";
import { atomicWrite, type BotBinding, readBotsConfig, readCursor } from "./config.ts";
import { spokenDate } from "./history.ts";
import { Chat, VIEW_HI } from "./tree.ts";

const SCRIPT = ".claude/hooks/t3-bot-memory";
const HOOK = `sh "$CLAUDE_PROJECT_DIR/${SCRIPT}" session-start`;
const BB_HOOK = 'sh "$CLAUDE_PROJECT_DIR/.claude/hooks/bb-memory-session-start.sh"';
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

type HookGroup = { hooks?: Array<{ command?: string }> };
type Settings = { hooks?: { SessionStart?: HookGroup[] } };

function assertBinding(db: NodeSqlite.DatabaseSync, bot: BotBinding): void {
  const thread = db
    .prepare(`
    SELECT p.workspace_root AS workspace,
      json_extract(t.payload_json, '$.worktreePath') AS worktree,
      json_extract(t.payload_json, '$.historyOrigin') AS origin,
      (SELECT max(sequence) FROM orchestration_events
        WHERE aggregate_kind = 'thread' AND stream_id = t.thread_id) AS head,
      (SELECT count(*) FROM orchestration_v2_projection_runs WHERE thread_id = t.thread_id) AS runs
    FROM orchestration_v2_projection_threads t
    JOIN projection_projects p ON p.project_id = t.project_id
    WHERE t.thread_id = ? AND t.archived_at IS NULL AND t.deleted_at IS NULL
  `)
    .get(bot.threadId);
  const workspace = thread?.worktree ?? thread?.workspace;
  if (
    thread?.origin !== "bb_import" ||
    typeof workspace !== "string" ||
    NodeFS.realpathSync(workspace) !== NodeFS.realpathSync(bot.home)
  ) {
    throw new Error(`Bot ${bot.id} must target an active imported thread in its configured home`);
  }
  if (
    typeof thread.head !== "number" ||
    bot.afterSequence > thread.head ||
    (thread.runs === 0 && bot.afterSequence !== thread.head)
  ) {
    throw new Error(
      `Bot ${bot.id} has an invalid T3 event boundary. Thread head is ${thread.head}`,
    );
  }
  const source = JSON.parse(
    NodeFS.readFileSync(NodePath.join(bot.memoryDir, "memory.json"), "utf8"),
  ) as {
    on?: boolean;
    main?: string;
  };
  if (
    source.on !== true ||
    typeof source.main !== "string" ||
    bbThreadId(source.main) !== bot.threadId
  ) {
    throw new Error(`Copied memory for ${bot.id} does not belong to its imported thread`);
  }
  readCursor(bot);
}

export function installHooks(directory: string): void {
  const stateDir = NodePath.resolve(directory);
  const { bots } = readBotsConfig(stateDir);
  if (bots.length === 0) throw new Error("No bot bindings in fork-bots.json");
  const db = new NodeSqlite.DatabaseSync(NodePath.join(stateDir, "statev2.sqlite"), {
    readOnly: true,
  });
  try {
    for (const bot of bots) assertBinding(db, bot);
  } finally {
    db.close();
  }

  const launcher = (
    NodeSea.isSea() ? [process.execPath] : [process.execPath, NodePath.resolve(process.argv[1]!)]
  )
    .map(shellQuote)
    .join(" ");
  for (const { home } of bots) {
    const script = NodePath.join(home, SCRIPT);
    const settingsFile = NodePath.join(home, ".claude/settings.json");
    const settings = (
      NodeFS.existsSync(settingsFile) ? JSON.parse(NodeFS.readFileSync(settingsFile, "utf8")) : {}
    ) as Settings;
    const hooks = settings.hooks ?? {};
    const groups = (hooks.SessionStart ?? [])
      .map((group) => ({
        ...group,
        hooks:
          group.hooks?.filter((hook) => hook.command !== BB_HOOK && hook.command !== HOOK) ?? [],
      }))
      .filter((group) => group.hooks.length);
    const next = {
      ...settings,
      hooks: {
        ...hooks,
        SessionStart: [
          ...groups,
          {
            matcher: "startup|clear|compact",
            hooks: [{ type: "command", command: HOOK, timeout: 30 }],
          },
        ],
      },
    };
    NodeFS.mkdirSync(NodePath.dirname(script), { recursive: true });
    atomicWrite(
      script,
      `#!/bin/sh\naction=$1\nshift\nexec ${launcher} bots "$action" ${shellQuote(stateDir)} "$@"\n`,
    );
    NodeFS.chmodSync(script, 0o700);
    atomicWrite(settingsFile, JSON.stringify(next, null, 2) + "\n");
  }
}

export function callingBot(stateDir: string, cwd: string): BotBinding | undefined {
  const threadId = process.env.T3CODE_THREAD_ID;
  if (!threadId) return;
  const bot = readBotsConfig(stateDir).bots.find((entry) => entry.threadId === threadId);
  if (bot && NodeFS.realpathSync(cwd) === NodeFS.realpathSync(bot.home)) return bot;
}

export function sessionStart(stateDir: string): void {
  const { cwd, source } = JSON.parse(NodeFS.readFileSync(0, "utf8")) as {
    cwd?: string;
    source?: string;
  };
  if (!cwd || !source || !["startup", "clear", "compact"].includes(source)) return;
  const bot = callingBot(stateDir, cwd);
  if (!bot) return;
  const file = NodePath.join(bot.home, "nosync", "t3-bot-memory.md");
  try {
    const chat = Chat.read(bot.memoryDir);
    if (chat.viewBytes().view > VIEW_HI) throw new Error("Memory view exceeds its limit");
    const command = shellQuote(NodePath.join(bot.home, SCRIPT));
    const snapshot = [
      "# Bot memory",
      `Thread ${bot.threadId}. This view covers ${chat.T} messages as of ${new Date().toISOString()}.`,
      "Each line is id+n, the summary of n messages starting at id.",
      `Run \`${command} recall <id> <n>\` to expand a line. Use n=1 for the full message.`,
      `Run \`${command} date <id>\` for its timestamp.`,
      "<chat>",
      ...chat.viewLines(),
      "</chat>",
      "",
    ].join("\n");
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true, mode: 0o700 });
    atomicWrite(file, snapshot);
    process.stdout.write(`Before answering, read your memory at ${file} in full.\n`);
  } catch (error) {
    process.stderr.write(`Bot memory hook failed: ${String(error)}\n`);
    process.stdout.write(
      "Your bot memory could not be loaded. Let the user know before working on the request.\n",
    );
  }
}

export function recall(stateDir: string, id: number, n: number | undefined): void {
  const bot = callingBot(stateDir, process.cwd());
  if (!bot) throw new Error("Bot memory is available from its main chat in its home.");
  const chat = Chat.read(bot.memoryDir);
  process.stdout.write((n === undefined ? spokenDate(chat.date(id)) : chat.zoom(id, n)) + "\n");
}
