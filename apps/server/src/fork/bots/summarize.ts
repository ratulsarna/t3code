// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off globalConsole:off -- The summary runner owns subprocess timeouts and shutdown outside Effect.
// Summary calls for every memory chat, through a CLI on the host: `claude -p` on its Claude
// login, or `pi -p` with any model pi knows. One pool across all chats, so a long import cannot
// crowd the account or starve a live chat.
import * as NodeChildProcess from "node:child_process";
import { SUMMARY_PROMPT } from "./prompt.ts";
import { bytes, type Chat, cleanLine, type Job, LINE, tooLong } from "./tree.ts";

const ATTEMPTS = 5;
const CALL_TIMEOUT_MS = 3 * 60_000;
/** Failed calls in a row that stop all summaries for `BRAKE_MS`: a spent account fails every call. */
const BRAKE_AFTER = 5;
const BRAKE_MS = 10 * 60_000;

const without = (env: NodeJS.ProcessEnv, drop: (key: string) => boolean): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).filter(([k]) => !drop(k)));

/**
 * How each CLI is asked for one summary: one reply on stdout, no tools, no session, and nothing
 * loaded from disk.
 */
const RUNNERS = {
  claude: {
    args: (model: string) => [
      "-p",
      "--safe-mode",
      "--tools",
      "",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--model",
      model,
      "--system-prompt",
      SUMMARY_PROMPT,
      "--output-format",
      "text",
    ],
    // The subscription login, never an API key.
    env: (env: NodeJS.ProcessEnv) =>
      without(
        env,
        (k) => k.startsWith("ANTHROPIC_") || k.startsWith("BB_") || k === "CLAUDE_CODE_OAUTH_TOKEN",
      ),
  },
  pi: {
    args: (model: string) => [
      "-p",
      "--no-session",
      "--no-tools",
      "--no-extensions",
      "--no-mcp",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--thinking",
      "off",
      "--model",
      model,
      "--system-prompt",
      SUMMARY_PROMPT,
    ],
    env: (env: NodeJS.ProcessEnv) => without(env, (k) => k.startsWith("BB_")),
  },
};
export type SummaryRunner = keyof typeof RUNNERS;

export class Summarizer {
  private readonly chats: Array<{ identity: string; chat: Chat }> = [];
  private turn = 0;
  private running = 0;
  private readonly procs = new Set<NodeChildProcess.ChildProcess>();
  private disposed = false;
  private failedInRow = 0;
  private brakeUntil = 0;
  private brakeTimer: NodeJS.Timeout | undefined;
  private readonly scratch: string;
  private readonly runner;
  private readonly model;
  private readonly pool;
  private readonly binary;

  constructor(
    scratch: string,
    options?: { runner: SummaryRunner; model: string; pool?: number; binary?: string },
  ) {
    this.scratch = scratch;
    this.runner = options?.runner ?? "claude";
    this.model = options?.model ?? "haiku";
    this.pool = options?.pool ?? 8;
    this.binary = options?.binary ?? this.runner;
  }

  add(identity: string, chat: Chat): void {
    this.chats.push({ identity, chat });
  }

  /** Stop giving `chat` work; calls already running for it finish and are dropped. */
  remove(chat: Chat): void {
    const k = this.chats.findIndex((member) => member.chat === chat);
    if (k >= 0) this.chats.splice(k, 1);
  }

  private blocked(): boolean {
    return this.brakeUntil > Date.now();
  }

  /** Start jobs while the pool has room, taking from each chat in turn. */
  pump(): void {
    if (this.blocked()) return;
    for (let empty = 0; !this.disposed && this.running < this.pool && empty < this.chats.length;) {
      const member = this.chats[this.turn++ % this.chats.length]!;
      const job = member.chat.take();
      if (!job) {
        empty++;
        continue;
      }
      empty = 0;
      void this.run(member, job);
    }
  }

  private async run({ identity, chat }: { identity: string; chat: Chat }, job: Job): Promise<void> {
    this.running++;
    let line: string | undefined;
    let why = "empty reply";
    try {
      line = await this.summarize(job.prompt);
    } catch (error) {
      why = error instanceof Error ? error.message : String(error);
      if (!this.disposed) console.warn(`memory ${identity}: summary failed: ${why}`);
    }
    this.running--;
    if (this.disposed || !this.chats.some((member) => member.chat === chat)) {
      this.pump();
      return;
    }
    if (line === undefined) {
      chat.fail(job.ref);
      if (++this.failedInRow >= BRAKE_AFTER) this.brake(why);
    } else {
      chat.done(job.ref, line);
      this.failedInRow = 0;
    }
    // A damaged chat dropped the line, and its slot still goes back to the pool.
    if (!chat.damage)
      chat
        .flush()
        .catch((error) =>
          console.warn(
            `memory ${identity}: summary not saved: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
    this.pump();
  }

  /** Calls still in flight may fail too; they do not stop it again. */
  private brake(why: string): void {
    this.failedInRow = 0;
    if (this.brakeUntil > Date.now()) return;
    const ms = BRAKE_MS;
    this.brakeUntil = Date.now() + ms;
    const warning = `Memory summaries stopped for ${Math.ceil(ms / 60_000)} min after ${BRAKE_AFTER} failed calls in a row. Last error: ${why.slice(0, 200)}`;
    console.warn(warning);
    this.brakeTimer = setTimeout(() => {
      this.brakeUntil = 0;
      for (const { chat } of this.chats) chat.retryFailed();
      this.pump();
    }, ms);
  }

  /** The first line that fits, else the shortest of `ATTEMPTS` (fewer once summaries stop); undefined for an empty reply. */
  private async summarize(input: string): Promise<string | undefined> {
    let best: string | undefined;
    let last: string | undefined;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      // Paused or braked since the last try: keep the shortest line rather than start another call.
      if (attempt > 0 && this.blocked()) break;
      // Each call is fresh, so a retry carries the input again with the cut the last reply overran.
      last = cleanLine(
        await this.call(last === undefined ? input : `${input}\n\n${tooLong(last)}`),
      );
      if (!last) return undefined;
      if (best === undefined || bytes(last) < bytes(best)) best = last;
      if (bytes(last) <= LINE) return last;
    }
    return best;
  }

  private call(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this.disposed) return reject(new Error("memory service stopped"));
      const runner = this.runner;
      const { args, env } = RUNNERS[runner];
      const child = NodeChildProcess.spawn(this.binary, args(this.model), {
        cwd: this.scratch,
        env: env(process.env),
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.procs.add(child);
      let out = "";
      let err = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, CALL_TIMEOUT_MS);
      const settle = (error?: Error) => {
        clearTimeout(timer);
        this.procs.delete(child);
        if (error) reject(error);
        else resolve(out);
      };
      child.stdout?.on("data", (d) => (out += d));
      child.stderr?.on("data", (d) => (err += d));
      child.once("error", settle);
      child.once("close", (code, signal) => {
        if (code === 0) return settle();
        // A failed claude -p can leave only a sign-in notice on stderr; the reason, a spent plan for one, is then on stdout.
        const why = [out, err]
          .map((s) => s.trim())
          .filter(Boolean)
          .join(" | ");
        settle(
          new Error(
            timedOut ? "timed out" : `${runner} exited ${code ?? signal}: ${why.slice(0, 300)}`,
          ),
        );
      });
      child.stdin?.on("error", () => {});
      child.stdin?.end(prompt);
    });
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.brakeTimer);
    for (const child of this.procs) child.kill("SIGKILL");
  }
}
