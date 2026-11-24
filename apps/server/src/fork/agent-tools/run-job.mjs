import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const deliveryTimeoutMs = 15 * 60_000;

function record(directory, outcome) {
  const draft = join(directory, "outcome.tmp");
  writeFileSync(draft, JSON.stringify(outcome) + "\n", { mode: 0o600 });
  renameSync(draft, join(directory, "outcome.json"));
}

function callT3(job, args, input) {
  return spawnSync(job.t3, [...args, "--base-dir", job.baseDir, "--json"], {
    encoding: "utf8",
    input,
    timeout: 45_000,
  });
}

const checkThread = (job) => callT3(job, ["thread", "show", job.threadId, "--messages", "1"]);

function start([t3, home, threadId, cwd, separator, command, ...args]) {
  if (!t3 || !isAbsolute(t3) || !home || !threadId || !cwd || separator !== "--" || !command) {
    throw new Error("Usage: node run-job.mjs <absolute-t3-bin> <t3-home> <thread-id> <cwd> -- <command> [args...]");
  }
  if (process.platform !== "linux" && process.platform !== "darwin") {
    throw new Error("Background jobs require systemd or launchd.");
  }

  const label = "t3-agent-job-" + randomUUID();
  const baseDir = resolve(home);
  const job = { t3, baseDir, threadId, cwd: resolve(cwd), command, args, path: process.env.PATH };
  if (checkThread(job).status !== 0) {
    throw new Error("Could not read the target thread on the selected T3 server.");
  }
  const directory = join(baseDir, "agent-jobs", label);
  mkdirSync(directory, { mode: 0o700, recursive: true });
  writeFileSync(
    join(directory, "job.json"),
    JSON.stringify(job),
    { mode: 0o600 },
  );
  const worker = [process.execPath, script, "--worker", directory];
  const result = process.platform === "linux"
    ? spawnSync("systemd-run", ["--user", "--quiet", "--collect", "--expand-environment=no", "--unit", label, "--", ...worker], {
        stdio: ["ignore", "ignore", "inherit"],
      })
    : spawnSync("launchctl", ["submit", "-l", label, "--", ...worker], {
        stdio: ["ignore", "ignore", "inherit"],
      });
  if (result.error || result.status !== 0) {
    record(directory, { status: "launch_failed" });
    throw new Error("Could not launch job. See " + directory, { cause: result.error });
  }
  console.log(JSON.stringify({ jobId: label, directory }));
}

async function run(directory) {
  const job = JSON.parse(readFileSync(join(directory, "job.json"), "utf8"));
  const outputPath = join(directory, "output.log");
  const output = openSync(outputPath, "wx", 0o600);
  record(directory, { status: "running" });
  let result;
  try {
    result = spawnSync(job.command, job.args, {
      cwd: job.cwd,
      env: { ...process.env, PATH: job.path ?? process.env.PATH },
      stdio: ["ignore", output, output],
    });
    if (result.error) writeFileSync(output, result.error.message + "\n");
  } finally {
    closeSync(output);
  }
  const exit = { exitCode: result.status, signal: result.signal, spawnFailed: !!result.error };
  record(directory, { status: "waiting_for_server", ...exit });

  const deadline = Date.now() + deliveryTimeoutMs;
  while (checkThread(job).status !== 0) {
    if (Date.now() >= deadline) {
      record(directory, { status: "delivery_expired", ...exit });
      return;
    }
    await delay(2000);
  }

  const completion = exit.spawnFailed ? "failed to start" : exit.signal ? "ended on " + exit.signal : "exited " + exit.exitCode;
  const message = `Background job ${basename(directory)} ${completion}. Output: ${outputPath}`;
  const sent = callT3(job, ["thread", "send", job.threadId, "-"], message);
  // Host CLI sends have no stable request id. A lost reply could already have queued the message.
  if (sent.status !== 0) {
    const error = sent.error?.message ?? sent.stderr.trim().slice(-1000);
    record(directory, { status: "delivery_unconfirmed", ...exit, error });
    return;
  }
  try {
    const receipt = JSON.parse(sent.stdout);
    if (typeof receipt.runId !== "string" || !["started", "queued"].includes(receipt.delivery)) {
      throw new Error("Invalid T3 send receipt");
    }
    record(directory, { status: "delivered", ...exit, delivery: receipt.delivery, runId: receipt.runId });
  } catch {
    record(directory, { status: "delivery_unconfirmed", ...exit, error: "Invalid T3 send receipt" });
  }
}

try {
  const args = process.argv.slice(2);
  if (args[0] === "--worker") {
    try {
      await run(args[1]);
    } finally {
      // launchctl submit keeps an exited service registered until it is removed.
      if (process.platform === "darwin") {
        spawnSync("launchctl", ["remove", basename(args[1])], { stdio: "ignore" });
      }
    }
  } else {
    start(args);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
