// @effect-diagnostics nodeBuiltinImport:off -- The fork ledger is a separate local SQLite database.
import { DatabaseSync } from "node:sqlite";
import {
  EnvironmentId,
  ModelSelection,
  type ProjectId,
  OrchestratorMcpThreadInterruptResult,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadSendResult,
  OrchestratorMcpThreadWaitResult,
  PipelineFailure,
  type PipelineMutation,
  ThreadId,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { randomUUID } from "node:crypto";

import { ServerConfig } from "../../config.ts";
import { ProjectToolkit } from "../../mcp/toolkits/project/tools.ts";
import { PeerLinks } from "../../peer/PeerLinks.ts";
import { PeerMcpClient } from "../../peer/PeerMcpClient.ts";
import { createCardStore } from "./store.ts";

type CardStore = ReturnType<typeof createCardStore>;
type PendingCard = ReturnType<CardStore["pending"]>[number];

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

function kickoff(card: PendingCard, snapshot: ReturnType<CardStore["snapshot"]>) {
  return `You are the Pipeline lead for card ${card.id}.
Title: ${card.title}
Mode: ${card.mode}. Size: ${card.size}. Shape review: ${card.shape_review ? "on" : "off"}.
Work in this managed worktree. Use native delegate_task to run a fresh on-node reviewer with only the review brief. Leave target.environmentId empty. Keep the report credential in this lead's conversation.

Update the hub using the command below, replacing <report JSON> with a JSON object such as {"kind":"status","column":"reviewing"}.
Stages: planning, plan_ready, implementing, reviewing, qa, pr, pr_ready, done. Include "needsYou" with a short reason when a user decision is needed, or null to clear it. Include "result" with the evidence and outcome when reporting completion. The card report does not answer questions in this conversation.
${reportCommand(card, snapshot)}

## Pinned lead instructions

${snapshot.snapshot}

## Task context

${card.body}`;
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
  const instructionsFile = Option.getOrUndefined(
    yield* Config.option(Config.String("T3CODE_PIPELINE_INSTRUCTIONS_FILE")),
  );
  const store =
    origin === null
      ? null
      : yield* Effect.acquireRelease(
          Effect.sync(() => new DatabaseSync(path.join(config.stateDir, "pipeline.sqlite"))),
          (db) => Effect.sync(() => db.close()),
        ).pipe(Effect.map(createCardStore));

  const requireStore = () => {
    if (!store || !origin) throw failed("Pipeline is off on this environment.");
    return store;
  };

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

  const reconcile = (db: CardStore, card: PendingCard) =>
    Effect.gen(function* () {
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
        const snapshot = db.snapshot(card.id);
        const modelSelection =
          card.lead_execution === null
            ? undefined
            : yield* Schema.decodeEffect(Schema.fromJsonString(ModelSelection))(
                card.lead_execution,
              );
        const outcome = yield* call(
          hostId,
          "t3_thread_launch",
          {
            projectId: card.project_id,
            title: `Lead · ${card.title}`.slice(0, 120),
            message: kickoff(card, snapshot),
            workspaceStrategy: { type: "worktree", baseRef: card.base_ref },
            runtimeMode: "approval-required",
            ...(modelSelection === undefined ? {} : { modelSelection }),
            clientRequestId: `pipeline:launch:${card.id}`,
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
                ...(current.run_state === "running" ? {} : { run_state: "paused" }),
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
            column: current.column === "todo" ? "planning" : current.column,
            launch_error: null,
            control_error: null,
            operation:
              current.run_state === "stopping"
                ? "stop"
                : current.run_state === "pause_requested"
                  ? "pause"
                  : null,
            operation_id: current.run_state === "running" ? null : randomUUID(),
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
                operation_id: randomUUID(),
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
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          const token = db.snapshot(card.id)?.report_token;
          const detail = token ? message(error).replaceAll(token, "[credential]") : message(error);
          db.apply(card.id, (current) =>
            current.operation === card.operation && current.operation_id === card.operation_id
              ? { control_error: detail }
              : undefined,
          );
        }),
      ),
    );

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
      const projects: Array<{
        hostId: EnvironmentId;
        projectId: ProjectId;
        title: string;
        hostLabel: string;
      }> = [];
      let cursor: number | null = 0;
      while (cursor !== null) {
        const page: typeof ProjectToolkit.tools.t3_project_list.successSchema.Type = yield* call(
          hostId,
          "t3_project_list",
          { cursor, limit: 100 },
          ProjectToolkit.tools.t3_project_list.successSchema,
        ).pipe(Effect.mapError((error) => failed(message(error))));
        projects.push(
          ...page.projects.map((project) => ({
            hostId,
            projectId: project.id,
            title: project.title,
            hostLabel: link.label,
          })),
        );
        cursor = page.nextCursor;
      }
      return projects;
    }),
    mutate: Effect.fn("Pipeline.mutate")(function* (action: PipelineMutation) {
      const db = yield* Effect.try({ try: requireStore, catch: (error) => failed(message(error)) });
      if (action.kind === "create") yield* storedLink(action.card.hostId);
      const pinsInstructions =
        action.kind === "create"
          ? action.card.start
          : (action.kind === "start" || (action.kind === "move" && action.column === "todo")) &&
            !db.get(action.id)?.start_requested;
      const instructions =
        pinsInstructions && instructionsFile
          ? yield* fs
              .readFileString(instructionsFile)
              .pipe(Effect.mapError(() => failed("Could not read Pipeline lead instructions.")))
          : "";
      if (instructions.length > 60_000)
        return yield* failed("Pipeline lead instructions exceed 60,000 characters.");
      const id = yield* Effect.try({
        try: () => db.mutate(action, instructions, origin!),
        catch: (error) =>
          Schema.is(PipelineFailure)(error) ? error : failed("Could not save the card."),
      });
      return { id };
    }),
  };
});

export class Pipeline extends Context.Service<Pipeline, Effect.Success<typeof make>>()(
  "t3/fork/pipeline/service/Pipeline",
) {}
export const layer = Layer.effect(Pipeline, make);
