// @effect-diagnostics nodeBuiltinImport:off -- The fork ledger is a separate local SQLite database.
import * as NodeSqlite from "node:sqlite";
import {
  EnvironmentId,
  ModelSelection,
  type PipelineStatsRange,
  ProjectId,
  OrchestratorMcpThreadInterruptResult,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadSendResult,
  OrchestratorMcpThreadWaitResult,
  PipelineFailure,
  type PipelineMutation,
  type Project,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Latch from "effect/Latch";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";

import { ServerConfig } from "../../config.ts";
import { ProjectToolkit } from "../../mcp/toolkits/project/tools.ts";
import { forkDatabaseFilename } from "../migrations.ts";
import { PeerLinks } from "../../peer/PeerLinks.ts";
import { PeerMcpClient } from "../../peer/PeerMcpClient.ts";
import { createCardStore, issueSnapshot, type CardRow } from "./store.ts";
import { createGithubSync } from "./github-sync.ts";
import {
  githubRepository,
  listAssignedIssues,
  normalizeGithubIssueUrl,
  readGithubIssue,
  readGithubViewer,
} from "./issue.ts";
import { projectStats } from "./stats.ts";
import { importedLaunchKey, pipelineWorktreeBranch } from "./worktree.ts";
import { readPullRequestBranch } from "./github.ts";

type CardStore = ReturnType<typeof createCardStore>;
type PendingCard = ReturnType<CardStore["pending"]>[number];

const decodeModelSelection = Schema.decodeEffect(Schema.fromJsonString(ModelSelection));
const isPipelineFailure = Schema.is(PipelineFailure);

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const failed = (message: string) => new PipelineFailure({ message });

const callbackOrigin = (value: string | undefined) => {
  if (value === undefined || value === "") return null;
  const url = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "T3CODE_PIPELINE_CALLBACK_URL must be an HTTPS origin or a loopback HTTP origin.",
    );
  }
  return url.origin;
};

const terminal = (status: OrchestratorMcpThreadWaitResult["status"]) =>
  status === "idle" ||
  status === "completed" ||
  status === "failed" ||
  status === "cancelled" ||
  status === "interrupted" ||
  status === "rolled_back";

function reportCommand(card: PendingCard, snapshot: ReturnType<CardStore["snapshot"]>) {
  return `curl --fail-with-body --silent --show-error --max-time 15 \
  --header 'Authorization: Bearer ${snapshot.report_token}' \
  --header 'Content-Type: application/json' \
  --data '<report JSON>' '${snapshot.callback_origin}/api/fork/pipeline/cards/${card.id}/report'`;
}

function repositoryOf(project: Project) {
  const identity = project.repositoryIdentity;
  if (identity && identity.provider === "github" && identity.owner && identity.name) {
    return `${identity.owner}/${identity.name}`;
  }
  const remote =
    project.repositoryIdentity?.origin?.remoteUrl ?? project.repositoryIdentity?.webUrl ?? null;
  try {
    return githubRepository(remote);
  } catch {
    return null;
  }
}

const issueContext = (card: PendingCard) => {
  const issue = issueSnapshot(card);
  if (!issue) return "";
  return `
## GitHub issue snapshot
${issue.url}
${issue.title}
Labels: ${issue.labels.join(", ")}
${issue.body}
${issue.comments.map((comment) => `${comment.author}: ${comment.body}`).join("\n")}`.slice(
    0,
    36_000,
  );
};

function kickoff(card: PendingCard, snapshot: ReturnType<CardStore["snapshot"]>) {
  return `You are the Pipeline lead for card ${card.id}.
Title: ${card.title}
Mode: ${card.mode}. Size: ${card.size}. Shape review: ${card.shape_review ? "on" : "off"}.
Work in this managed worktree. Use native delegate_task to run a fresh on-node reviewer with only the review brief. Leave target.environmentId empty. Keep the report credential in this lead's conversation.

Update the hub using the command below, replacing <report JSON> with a JSON object such as {"kind":"status","column":"reviewing"}.
Stages: planning, plan_ready, implementing, reviewing, qa, pr, pr_ready, done. Include "needsYou" with a short reason when a user decision is needed, or null to clear it. Include "result" with the evidence and outcome when reporting completion. The card report does not answer questions in this conversation.
Once you open a PR, report {"kind":"pull_request","url":"<GitHub pull request URL>"} and then {"kind":"review_wait"} when ready for external review. Pipeline sends review follow-ups. Leave native PR watching off for this lead.
${reportCommand(card, snapshot)}

## Pinned lead instructions

${snapshot.snapshot}

## Task context

${card.body}
${card.pr_url ? "Continue the existing pull request " + card.pr_url + " and report it before handing off review." : ""}
${issueContext(card)}`;
}

function pausePrompt(card: PendingCard, snapshot: ReturnType<CardStore["snapshot"]>) {
  return `Pause Pipeline task ${card.id}. Start no new work. Bring this task's workers and commands to a safe stopping point, pause any active goal, and leave a short handoff in this conversation. As your last action, report the pause using the command below with {"kind":"paused","requestId":"${card.operation_id}"}, then end your turn.
${reportCommand(card, snapshot)}`;
}

const resumePrompt = (card: PendingCard) =>
  `Resume Pipeline task ${card.id} from its handoff and files in this conversation's workspace. Check worker state, preserve completed work, and continue under its pinned instructions. If you need a user decision, report it to the card.`;

const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const links = yield* PeerLinks;
  const peers = yield* PeerMcpClient;
  const url = yield* Config.option(Config.String("T3CODE_PIPELINE_CALLBACK_URL"));
  const origin = callbackOrigin(Option.getOrUndefined(url));
  const configured = (name: string) =>
    Config.option(Config.String(name)).pipe(Config.map(Option.getOrUndefined));
  const githubSettings = {
    autoFollowup: (yield* configured("T3CODE_PIPELINE_AUTO_REVIEW")) !== "false",
  };
  const leadFile = yield* configured("T3CODE_PIPELINE_LEAD_FILE");
  const instructionsFile = Option.getOrUndefined(
    yield* Config.option(Config.String("T3CODE_PIPELINE_INSTRUCTIONS_FILE")),
  );
  const store =
    origin === null
      ? null
      : yield* Effect.acquireRelease(
          Effect.sync(
            () => new NodeSqlite.DatabaseSync(path.join(config.stateDir, forkDatabaseFilename)),
          ),
          (db) => Effect.sync(() => db.close()),
        ).pipe(Effect.map(createCardStore));

  const requireStore = () => {
    if (!store || !origin) throw failed("Pipeline is off on this environment.");
    return store;
  };

  const leadDefault = Effect.fn("Pipeline.leadDefault")(function* (db: CardStore) {
    const encoded =
      leadFile === undefined
        ? db.leadDefault()
        : yield* fs
            .readFileString(leadFile)
            .pipe(Effect.mapError(() => failed("Could not read the Pipeline lead model.")));
    return encoded === null
      ? null
      : yield* decodeModelSelection(encoded).pipe(
          Effect.mapError(() => failed("The Pipeline lead model setting is invalid.")),
        );
  });

  const storedLink = Effect.fn("Pipeline.storedLink")(function* (hostId: EnvironmentId) {
    if (!(yield* links.enabled)) return yield* failed("Turn on Linked environments on the hub.");
    const link = yield* links.get(hostId).pipe(Effect.mapError((error) => failed(error.message)));
    if (Option.isNone(link)) return yield* failed("The target environment is not linked.");
    if (link.value.access === "read-only")
      return yield* failed("The link needs at least Supervised access.");
    return link.value;
  });

  const call = <S extends Schema.Decoder<unknown>>(
    environmentId: EnvironmentId,
    tool: string,
    args: Record<string, unknown>,
    success: S,
  ) =>
    peers
      .call({
        environmentId,
        tool,
        arguments: args,
        success,
        limits: { runtimeMode: "approval-required", interactionMode: "default" },
      })
      .pipe(Effect.timeout("20 seconds"));

  const fetchIssue = (issueUrl: string) =>
    Effect.tryPromise({
      try: () => readGithubIssue(issueUrl),
      catch: (error) => failed(message(error)),
    });
  const projectPage = (hostId: EnvironmentId, cursor: number) =>
    call(
      hostId,
      "t3_project_list",
      { cursor, limit: 100 },
      ProjectToolkit.tools.t3_project_list.successSchema,
    ).pipe(Effect.mapError((error) => failed(message(error))));
  const linkedProjects = Effect.fn("Pipeline.linkedProjects")(function* (hostId: EnvironmentId) {
    yield* storedLink(hostId);
    const projects: Project[] = [];
    let cursor: number | null = 0;
    while (cursor !== null) {
      const page: typeof ProjectToolkit.tools.t3_project_list.successSchema.Type =
        yield* projectPage(hostId, cursor);
      projects.push(...page.projects);
      cursor = page.nextCursor;
    }
    return projects;
  });

  const fetchProject = Effect.fn("Pipeline.fetchProject")(function* (
    hostId: EnvironmentId,
    projectId: ProjectId,
  ) {
    const project = (yield* linkedProjects(hostId)).find((project) => project.id === projectId);
    if (!project) return yield* failed("This checkout is unavailable on the linked machine.");
    return project;
  });

  const importedDestination = Effect.fn("Pipeline.importedDestination")(function* (
    card: CardRow,
    local: ReturnType<CardStore["importTarget"]>,
  ) {
    const url = card.pr_url;
    const pr =
      url === null
        ? null
        : yield* Effect.tryPromise({
            try: (signal) => readPullRequestBranch(url, signal),
            catch: (error) => failed(message(error)),
          });
    const repository =
      pr?.repository ??
      local.repository ??
      (card.issue_url === null
        ? null
        : new URL(card.issue_url).pathname.split("/").slice(1, 3).join("/"));
    const branch = pr?.branch ?? local.branch ?? null;
    if (!repository || (card.start_requested && !branch)) {
      return yield* failed("Add the original repository and branch to the local resume map.");
    }
    if (local.hostId && local.projectId) {
      const hostId = EnvironmentId.make(local.hostId);
      const projectId = ProjectId.make(local.projectId);
      const project = yield* fetchProject(hostId, projectId);
      if (repositoryOf(project)?.toLowerCase() !== repository.toLowerCase()) {
        return yield* failed(
          "The selected checkout does not match the card’s original repository.",
        );
      }
      return { hostId, projectId, repository, branch };
    }
    const hosts = yield* links.names.pipe(Effect.mapError((error) => failed(error.message)));
    const matches = (yield* Effect.forEach(
      hosts,
      ({ environmentId: hostId }) =>
        linkedProjects(hostId).pipe(
          Effect.map((projects) =>
            projects
              .filter(
                (project) => repositoryOf(project)?.toLowerCase() === repository.toLowerCase(),
              )
              .map(({ id: projectId }) => ({ hostId, projectId, repository, branch })),
          ),
          Effect.orElseSucceed(() => []),
        ),
      { concurrency: 2 },
    )).flat();
    if (matches.length !== 1) {
      return yield* failed(
        matches.length === 0
          ? "Link a checkout of the original GitHub repository before resuming."
          : "More than one checkout matches. Select one in the local resume map.",
      );
    }
    return matches[0]!;
  });

  const reconcile = Effect.fn("Pipeline.reconcile")(
    function* (db: CardStore, card: PendingCard) {
      const hostId = EnvironmentId.make(card.host_id);
      const link = yield* storedLink(hostId);
      const identity = DateTime.formatIso(link.linkedAt);
      const operation = card.operation;
      const key = card.operation_id;
      const patch = (changes: Parameters<CardStore["apply"]>[1], history?: string) =>
        db.apply(
          card.id,
          (current) =>
            current.operation === operation && current.operation_id === key
              ? changes(current)
              : undefined,
          history,
        );

      if (operation === "launch") {
        if (card.link_identity !== null && card.link_identity !== identity) {
          return yield* failed(
            "The link was replaced after launch was attempted. Inspect the destination before retrying.",
          );
        }
        patch(() => ({ link_identity: identity }));
        let kickoffCard = card;
        if (card.issue_url !== null && !card.issue_refreshed) {
          const issue = yield* fetchIssue(card.issue_url).pipe(Effect.result);
          if (issue._tag === "Failure") {
            patch(
              (current) => ({
                launch_error: issue.failure.message,
                occupies_slot: 0,
                operation: null,
                operation_id: null,
                ...(current.historical || current.run_state !== "running"
                  ? { run_state: "paused" }
                  : {}),
              }),
              "launch_failed",
            );
            return;
          }
          patch(() => ({ issue_refreshed: 1, issue_snapshot: JSON.stringify(issue.success) }));
          kickoffCard = db.get(card.id) ?? card;
        }
        const snapshot = db.snapshot(card.id);
        const selected = yield* (
          card.lead_execution === null
            ? leadDefault(db)
            : decodeModelSelection(card.lead_execution).pipe(
                Effect.mapError(() => failed("The card’s saved lead model is invalid.")),
              )
        ).pipe(Effect.result);
        if (selected._tag === "Failure" || selected.success === null) {
          patch(
            (current) => ({
              launch_error:
                selected._tag === "Failure"
                  ? selected.failure.message
                  : "Set a Pipeline lead model before starting this card.",
              occupies_slot: 0,
              operation: null,
              operation_id: null,
              ...(current.historical || current.run_state !== "running"
                ? { run_state: "paused" }
                : {}),
            }),
            "launch_failed",
          );
          return;
        }
        const modelSelection = selected.success;
        if (card.lead_execution === null)
          patch(() => ({ lead_execution: JSON.stringify(modelSelection) }));
        const outcome = yield* call(
          hostId,
          "t3_thread_launch",
          {
            projectId: card.project_id,
            title: `Lead · ${card.title}`.slice(0, 120),
            message: kickoff(kickoffCard, snapshot),
            workspaceStrategy: {
              type: "worktree",
              baseRef: card.base_ref,
              branch: card.import_branch ?? pipelineWorktreeBranch(card.id),
              ...(card.import_branch ? { startFromOrigin: true } : {}),
            },
            runtimeMode: "approval-required",
            modelSelection,
            clientRequestId: card.historical
              ? importedLaunchKey(card.id)
              : `pipeline:launch:${card.id}`,
          },
          ProjectToolkit.tools.t3_thread_launch.successSchema,
        ).pipe(Effect.result);
        if (outcome._tag === "Failure") {
          const error = outcome.failure;
          if (
            error._tag === "OrchestratorMcpFailure" &&
            (error.code === "invalid_request" || error.code === "model_unavailable")
          ) {
            patch(
              (current) => ({
                launch_error: error.message.replaceAll(snapshot.report_token, "[credential]"),
                occupies_slot: 0,
                operation: null,
                operation_id: null,
                ...(current.historical || current.run_state !== "running"
                  ? { run_state: "paused" }
                  : {}),
              }),
              "launch_failed",
            );
            return;
          }
          return yield* error;
        }
        patch(
          (current) => ({
            lead_thread_id: outcome.success.threadId,
            lead_environment_id: card.host_id,
            historical: 0,
            column: current.column === "todo" ? "planning" : current.column,
            launch_error: null,
            control_error: null,
            operation:
              current.run_state === "stopping"
                ? "stop"
                : current.run_state === "pause_requested"
                  ? "pause"
                  : null,
            operation_id: current.run_state === "running" ? null : NodeCrypto.randomUUID(),
          }),
          "launched",
        );
        return;
      }

      if (card.lead_thread_id === null)
        return yield* failed("The lead thread has not been recovered.");
      const threadId = ThreadId.make(card.lead_thread_id);
      if (operation === "pause" || operation === "resume") {
        const prompt =
          operation === "pause" ? pausePrompt(card, db.snapshot(card.id)) : resumePrompt(card);
        yield* call(
          hostId,
          "t3_thread_send",
          {
            threadId,
            message: prompt,
            mode: "auto",
            clientRequestId: `pipeline:${operation}:${key}`,
          },
          OrchestratorMcpThreadSendResult,
        );
        patch(
          (current) => {
            if (operation === "resume" && current.run_state !== "running") {
              return {
                operation: current.run_state === "stopping" ? "stop" : "pause",
                operation_id: NodeCrypto.randomUUID(),
                control_error: null,
              };
            }
            return { operation: null, control_error: null };
          },
          operation === "pause" ? "pause_delivered" : "resumed",
        );
        return;
      }

      if (operation === "stop") {
        yield* call(
          hostId,
          "t3_thread_interrupt",
          {
            threadId,
            stop: true,
            clientRequestId: `pipeline:stop:${key}`,
            reason: "Pipeline Stop now",
          },
          OrchestratorMcpThreadInterruptResult,
        );
        patch(() => ({ operation: null, control_error: null }), "stop_delivered");
        return;
      }

      if (card.run_state === "pause_requested") return;
      if (card.run_state === "pausing" || card.run_state === "stopping" || card.column === "done") {
        const result = yield* call(
          hostId,
          "t3_thread_wait",
          {
            threadId,
            timeoutMs: 1,
            untilDelegatedWorkSettled: true,
          },
          OrchestratorMcpThreadWaitResult,
        );
        const read = yield* call(
          hostId,
          "t3_thread_read",
          {
            threadId,
            limit: 1,
            runLimit: 1,
            maxCharsPerItem: 1,
          },
          OrchestratorMcpThreadReadResult,
        );
        if (
          !result.timedOut &&
          terminal(result.status) &&
          read.thread.activeRunId === null &&
          !read.thread.pendingBackgroundTasks?.length
        ) {
          patch(
            (current) =>
              current.run_state === card.run_state && current.column === card.column
                ? {
                    run_state: card.column === "done" ? "running" : "paused",
                    occupies_slot: 0,
                    control_error: null,
                  }
                : undefined,
            card.column === "done" ? "released" : "paused",
          );
        }
      }
    },
    (effect, db, card) =>
      effect.pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            const token = db.snapshot(card.id)?.report_token;
            const detail = token
              ? message(error).replaceAll(token, "[credential]")
              : message(error);
            db.apply(card.id, (current) =>
              current.operation === card.operation && current.operation_id === card.operation_id
                ? { control_error: detail }
                : undefined,
            );
          }),
        ),
      ),
  );

  const github = store === null ? null : createGithubSync(store, call, githubSettings);
  const githubWake = yield* Latch.make(false);
  if (github !== null) {
    yield* github.poll.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Pipeline GitHub reconciliation failed", cause),
      ),
      Effect.andThen(githubWake.await.pipe(Effect.timeoutOption("60 seconds"))),
      Effect.andThen(githubWake.close),
      Effect.forever,
      Effect.forkScoped,
    );
  }
  if (store !== null) {
    const tick = Effect.gen(function* () {
      store.claim();
      yield* Effect.forEach(store.pending(), (card) => reconcile(store, card), {
        concurrency: 8,
        discard: true,
      });
    });
    yield* tick.pipe(
      Effect.catchCause((cause) => Effect.logError("Pipeline reconciliation failed", cause)),
      Effect.andThen(Effect.sleep("2 seconds")),
      Effect.forever,
      Effect.forkScoped,
    );
  }

  return {
    store,
    wakeGithub: githubWake.open,
    issues: Effect.fn("Pipeline.issues")(function* (hostId: EnvironmentId, projectId: ProjectId) {
      const repository = repositoryOf(yield* fetchProject(hostId, projectId));
      if (!repository) return yield* failed("This checkout has no GitHub repository.");
      return yield* Effect.tryPromise({
        try: async () => {
          const viewer = await readGithubViewer();
          const items = [];
          for (let page = 1; page <= 10; page++) {
            const next = await listAssignedIssues(repository, viewer, page);
            items.push(...next.issues);
            if (!next.hasMore) break;
          }
          return items;
        },
        catch: (error) => failed(message(error)),
      });
    }),
    stats: Effect.fn("Pipeline.stats")(function* (
      projectId: ProjectId,
      hostId: EnvironmentId,
      range: PipelineStatsRange,
    ) {
      const db = yield* Effect.try({ try: requireStore, catch: (error) => failed(message(error)) });
      const now = yield* Clock.currentTimeMillis;
      const cards = db
        .cards()
        .filter((card) => card.projectId === projectId && card.hostId === hostId);
      return projectStats(cards, db.history(projectId, hostId), {
        from: range === "all" ? 0 : now - Number(range) * 86_400_000,
        now,
      });
    }),
    board: Effect.gen(function* () {
      const hosts =
        store === null || !(yield* links.enabled)
          ? []
          : yield* links.names.pipe(Effect.mapError((error) => failed(error.message)));
      return {
        enabled: store !== null,
        hosts: [...hosts].map(({ environmentId, label }) => ({ id: environmentId, label })),
        cards: store?.cards() ?? [],
        limits: store?.limits() ?? [],
      };
    }),
    projects: Effect.fn("Pipeline.projects")(function* (hostId: EnvironmentId) {
      yield* Effect.try({ try: requireStore, catch: (error) => failed(message(error)) });
      const link = yield* storedLink(hostId);
      return (yield* linkedProjects(hostId)).map((project) => ({
        hostId,
        projectId: project.id,
        title: project.title,
        hostLabel: link.label,
        githubRepository: repositoryOf(project),
      }));
    }),
    mutate: Effect.fn("Pipeline.mutate")(function* (action: PipelineMutation) {
      const db = yield* Effect.try({ try: requireStore, catch: (error) => failed(message(error)) });
      const repository =
        action.kind === "create"
          ? repositoryOf(yield* fetchProject(action.card.hostId, action.card.projectId))
          : null;
      const issue = yield* Effect.gen(function* () {
        if (action.kind !== "create") return null;
        if (!action.card.issueUrl) return null;
        const url = normalizeGithubIssueUrl(action.card.issueUrl);
        if (!url) return yield* failed("Expected a GitHub issue URL.");
        if (
          !repository ||
          !url.toLowerCase().startsWith(`https://github.com/${repository.toLowerCase()}/issues/`)
        ) {
          return yield* failed("The issue belongs to a different repository.");
        }
        return yield* fetchIssue(url);
      });
      const imported = action.kind === "resume" ? db.get(action.id) : null;
      const pinsInstructions =
        action.kind === "create"
          ? action.card.start
          : (imported?.historical && !db.snapshot(imported.id)) ||
            ((action.kind === "start" || (action.kind === "move" && action.column === "todo")) &&
              !db.get(action.id)?.start_requested);
      const instructions =
        pinsInstructions && instructionsFile
          ? yield* fs
              .readFileString(instructionsFile)
              .pipe(Effect.mapError(() => failed("Could not read Pipeline lead instructions.")))
          : "";
      if (instructions.length > 60_000)
        return yield* failed("Pipeline lead instructions exceed 60,000 characters.");
      if (imported?.historical) {
        if (imported.column === "done") return yield* failed("Done cards are imported as history.");
        if (imported.operation !== null) return { id: imported.id };
        const destination = yield* importedDestination(imported, db.importTarget(imported.id));
        const id = yield* Effect.try({
          try: () => db.resumeImported(imported.id, destination, instructions, origin!),
          catch: (error) =>
            isPipelineFailure(error) ? error : failed("Could not queue the imported card."),
        });
        return { id };
      }
      const defaultModel =
        action.kind === "create" && action.card.lead === undefined ? yield* leadDefault(db) : null;
      const mutation =
        action.kind === "create" && defaultModel !== null
          ? { ...action, card: { ...action.card, lead: defaultModel } }
          : action;
      const id = yield* Effect.try({
        try: () => db.mutate(mutation, instructions, origin!, issue, repository),
        catch: (error) => (isPipelineFailure(error) ? error : failed("Could not save the card.")),
      });
      if (action.kind === "send_review" || action.kind === "refresh_github") yield* githubWake.open;
      return { id };
    }),
  };
});

export class Pipeline extends Context.Service<Pipeline, Effect.Success<typeof make>>()(
  "t3/fork/pipeline/service/Pipeline",
) {}
export const layer = Layer.effect(Pipeline, make);
