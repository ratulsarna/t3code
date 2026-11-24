import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeURL from "node:url";

const script = NodeURL.fileURLToPath(import.meta.url);
// oxlint-disable-next-line t3code/no-global-process-runtime -- This script runs with the standalone T3 binary and no workspace packages.
const platform = process.platform;
const deliveryTimeoutMs = 15 * 60_000;

function record(directory, outcome) {
  const draft = NodePath.join(directory, "outcome.tmp");
  NodeFS.writeFileSync(draft, JSON.stringify(outcome) + "\n", { mode: 0o600 });
  NodeFS.renameSync(draft, NodePath.join(directory, "outcome.json"));
}

function callT3(job, args, input) {
  return NodeChildProcess.spawnSync(job.t3, [...args, "--base-dir", job.baseDir, "--json"], {
    encoding: "utf8",
    input,
    timeout: 45_000,
  });
}

const checkThread = (job) => callT3(job, ["thread", "show", job.threadId, "--messages", "1"]);

function start([t3, home, threadId, cwd, separator, command, ...args]) {
  if (
    !t3 ||
    !NodePath.isAbsolute(t3) ||
    !home ||
    !threadId ||
    !cwd ||
    separator !== "--" ||
    !command
  ) {
    throw new Error(
      "Usage: node run-job.mjs <absolute-t3-bin> <t3-home> <thread-id> <cwd> -- <command> [args...]",
    );
  }
  if (platform !== "linux" && platform !== "darwin") {
    throw new Error("Background jobs require systemd or launchd.");
  }

  const label = "t3-agent-job-" + NodeCrypto.randomUUID();
  const baseDir = NodePath.resolve(home);
  const job = {
    t3,
    baseDir,
    threadId,
    cwd: NodePath.resolve(cwd),
    command,
    args,
    path: process.env.PATH,
  };
  if (checkThread(job).status !== 0) {
    throw new Error("Could not read the target thread on the selected T3 server.");
  }
  const directory = NodePath.join(baseDir, "agent-jobs", label);
  NodeFS.mkdirSync(directory, { mode: 0o700, recursive: true });
  NodeFS.writeFileSync(NodePath.join(directory, "job.json"), JSON.stringify(job), { mode: 0o600 });
  const worker = [process.execPath, script, "--worker", directory];
  const result =
    platform === "linux"
      ? NodeChildProcess.spawnSync(
          "systemd-run",
          [
            "--user",
            "--quiet",
            "--collect",
            "--expand-environment=no",
            "--unit",
            label,
            "--",
            ...worker,
          ],
          {
            stdio: ["ignore", "ignore", "inherit"],
          },
        )
      : NodeChildProcess.spawnSync("launchctl", ["submit", "-l", label, "--", ...worker], {
          stdio: ["ignore", "ignore", "inherit"],
        });
  if (result.error || result.status !== 0) {
    record(directory, { status: "launch_failed" });
    throw new Error("Could not launch job. See " + directory, { cause: result.error });
  }
  console.log(JSON.stringify({ jobId: label, directory }));
}

async function run(directory) {
  const job = JSON.parse(NodeFS.readFileSync(NodePath.join(directory, "job.json"), "utf8"));
  const outputPath = NodePath.join(directory, "output.log");
  const output = NodeFS.openSync(outputPath, "wx", 0o600);
  record(directory, { status: "running" });
  let result;
  try {
    result = NodeChildProcess.spawnSync(job.command, job.args, {
      cwd: job.cwd,
      env: { ...process.env, PATH: job.path ?? process.env.PATH },
      stdio: ["ignore", output, output],
    });
    if (result.error) NodeFS.writeFileSync(output, result.error.message + "\n");
  } finally {
    NodeFS.closeSync(output);
  }
  const exit = { exitCode: result.status, signal: result.signal, spawnFailed: !!result.error };
  record(directory, { status: "waiting_for_server", ...exit });

  const deadline = Date.now() + deliveryTimeoutMs;
  while (checkThread(job).status !== 0) {
    if (Date.now() >= deadline) {
      record(directory, { status: "delivery_expired", ...exit });
      return;
    }
    await NodeTimersPromises.setTimeout(2000);
  }

  const completion = exit.spawnFailed
    ? "failed to start"
    : exit.signal
      ? "ended on " + exit.signal
      : "exited " + exit.exitCode;
  const message = `Background job ${NodePath.basename(directory)} ${completion}. Output: ${outputPath}`;
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
    record(directory, {
      status: "delivered",
      ...exit,
      delivery: receipt.delivery,
      runId: receipt.runId,
    });
  } catch {
    record(directory, {
      status: "delivery_unconfirmed",
      ...exit,
      error: "Invalid T3 send receipt",
    });
  }
}

try {
  const args = process.argv.slice(2);
  if (args[0] === "--worker") {
    try {
      await run(args[1]);
    } finally {
      // launchctl submit keeps an exited service registered until it is removed.
      if (platform === "darwin") {
        NodeChildProcess.spawnSync("launchctl", ["remove", NodePath.basename(args[1])], {
          stdio: "ignore",
        });
      }
    }
  } else {
    start(args);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
