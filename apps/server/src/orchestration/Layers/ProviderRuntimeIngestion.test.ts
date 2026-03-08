import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { OrchestrationReadModel, ProviderRuntimeEvent } from "@t3tools/contracts";
import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderItemId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Effect, Exit, Layer, ManagedRuntime, PubSub, Scope, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../../persistence/Layers/ProviderSessionRuntime.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { ProviderSessionDirectoryLive } from "../../provider/Layers/ProviderSessionDirectory.ts";
import { ProviderSessionRuntimeRepository } from "../../persistence/Services/ProviderSessionRuntime.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { ProviderRuntimeIngestionLive } from "./ProviderRuntimeIngestion.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { ServerConfig } from "../../config.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);
const asItemId = (value: string): ProviderItemId => ProviderItemId.makeUnsafe(value);
const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
const asMessageId = (value: string): MessageId => MessageId.makeUnsafe(value);
const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);

type LegacyProviderRuntimeEvent = {
  readonly type: string;
  readonly eventId: EventId;
  readonly provider: "codex";
  readonly createdAt: string;
  readonly threadId: ThreadId;
  readonly providerThreadId?: string | undefined;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly payload?: unknown | undefined;
  readonly [key: string]: unknown;
};

function createProviderServiceHarness() {
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());

  const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
  const service: ProviderServiceShape = {
    startSession: () => unsupported(),
    sendTurn: () => unsupported(),
    interruptTurn: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: () => unsupported(),
    stopLiveSessionIfPresent: () => Effect.void,
    listSessions: () => Effect.succeed([]),
    getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
    rollbackConversation: () => unsupported(),
    streamEvents: Stream.fromPubSub(runtimeEventPubSub),
  };

  const emit = (event: LegacyProviderRuntimeEvent): void => {
    Effect.runSync(PubSub.publish(runtimeEventPubSub, event as unknown as ProviderRuntimeEvent));
  };

  return {
    service,
    emit,
  };
}

async function waitForThread(
  engine: OrchestrationEngineShape,
  predicate: (thread: ProviderRuntimeTestThread) => boolean,
  timeoutMs = 2000,
  threadId = "thread-1",
) {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<ProviderRuntimeTestThread> => {
    const readModel = await Effect.runPromise(engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe(threadId));
    if (thread && predicate(thread)) {
      return thread;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for thread state");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };
  return poll();
}

type ProviderRuntimeTestReadModel = OrchestrationReadModel;
type ProviderRuntimeTestThread = ProviderRuntimeTestReadModel["threads"][number];
type ProviderRuntimeTestMessage = ProviderRuntimeTestThread["messages"][number];
type ProviderRuntimeTestProposedPlan = ProviderRuntimeTestThread["proposedPlans"][number];
type ProviderRuntimeTestActivity = ProviderRuntimeTestThread["activities"][number];
type ProviderRuntimeTestCheckpoint = ProviderRuntimeTestThread["checkpoints"][number];

describe("ProviderRuntimeIngestion", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    | OrchestrationEngineService
    | ProviderRuntimeIngestionService
    | ProviderSessionRuntimeRepository,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const tempDirs: string[] = [];

  function makeTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

async function createHarness() {
    const workspaceRoot = makeTempDir("t3-provider-project-");
    fs.mkdirSync(path.join(workspaceRoot, ".git"));
    const provider = createProviderServiceHarness();
    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(SqlitePersistenceMemory),
    );
    const providerSessionRuntimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const providerSessionDirectoryLayer = ProviderSessionDirectoryLive.pipe(
      Layer.provide(providerSessionRuntimeRepositoryLayer),
    );
    const layer = ProviderRuntimeIngestionLive.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(Layer.succeed(ProviderService, provider.service)),
      Layer.provideMerge(providerSessionRuntimeRepositoryLayer),
      Layer.provideMerge(providerSessionDirectoryLayer),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const ingestion = await runtime.runPromise(Effect.service(ProviderRuntimeIngestionService));
    const providerSessionRuntimeRepository = await runtime.runPromise(
      Effect.service(ProviderSessionRuntimeRepository),
    );
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(ingestion.start.pipe(Scope.provide(scope)));
    await Effect.runPromise(Effect.sleep("10 millis"));

    const createdAt = new Date().toISOString();
    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-provider-project-create"),
        projectId: asProjectId("project-1"),
        title: "Provider Project",
        workspaceRoot,
        defaultModel: "gpt-5-codex",
        createdAt,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Thread",
        model: "gpt-5-codex",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-seed"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );

    return {
      engine,
      emit: provider.emit,
      providerSessionRuntimeRepository,
    };
  }

  async function materializeChildThread(
    harness: Awaited<ReturnType<typeof createHarness>>,
    input: {
      readonly threadId: string;
      readonly providerThreadId: string;
      readonly createdAt?: string;
      readonly title?: string;
    },
  ) {
    const createdAt = input.createdAt ?? new Date().toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.materialize",
        commandId: CommandId.makeUnsafe(`cmd-thread-materialize-${input.threadId}`),
        threadId: ThreadId.makeUnsafe(input.threadId),
        projectId: asProjectId("project-1"),
        title: input.title ?? "Child Thread",
        model: "gpt-5-codex",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        providerThreadId: input.providerThreadId,
        parentThreadId: ThreadId.makeUnsafe("thread-1"),
        origin: {
          kind: "subAgentThreadSpawn",
          parentProviderThreadId: "provider-thread-root-1",
        },
        createdAt,
      }),
    );
  }

  it("maps turn started/completed events into thread session updates", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: now,
      turnId: asTurnId("turn-1"),
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "running" && thread.session?.activeTurnId === "turn-1",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: new Date().toISOString(),
      turnId: asTurnId("turn-1"),
      payload: {
        state: "failed",
        errorMessage: "turn failed",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === "turn failed",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("turn failed");
  });

  it("applies provider session.state.changed transitions directly", async () => {
    const harness = await createHarness();
    const waitingAt = new Date().toISOString();

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-state-waiting"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: waitingAt,
      payload: {
        state: "waiting",
        reason: "awaiting approval",
      },
    });

    let thread = await waitForThread(
      harness.engine,
      (entry) => entry.session?.status === "running" && entry.session?.activeTurnId === null,
    );
    expect(thread.session?.status).toBe("running");
    expect(thread.session?.lastError).toBeNull();

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-state-error"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: new Date().toISOString(),
      payload: {
        state: "error",
        reason: "provider crashed",
      },
    });

    thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === "provider crashed",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("provider crashed");

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-state-stopped"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: new Date().toISOString(),
      payload: {
        state: "stopped",
      },
    });

    thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "stopped" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === "provider crashed",
    );
    expect(thread.session?.status).toBe("stopped");
    expect(thread.session?.lastError).toBe("provider crashed");

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-state-ready"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: new Date().toISOString(),
      payload: {
        state: "ready",
      },
    });

    thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "ready" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === null,
    );
    expect(thread.session?.status).toBe("ready");
    expect(thread.session?.lastError).toBeNull();
  });

  it("does not clear active turn when session/thread started arrives mid-turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-midturn-lifecycle"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-midturn-lifecycle"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-midturn-lifecycle",
    );

    harness.emit({
      type: "thread.started",
      eventId: asEventId("evt-thread-started-midturn-lifecycle"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      payload: {
        providerThreadId: "provider-thread-midturn",
        source: {
          kind: "subAgentThreadSpawn",
          parentProviderThreadId: "provider-parent-midturn",
          depth: 1,
          agentNickname: "Atlas",
          agentRole: "explorer",
        },
      },
    });
    harness.emit({
      type: "session.started",
      eventId: asEventId("evt-session-started-midturn-lifecycle"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
    });

    await Effect.runPromise(Effect.sleep("40 millis"));
    const midReadModel = await Effect.runPromise(harness.engine.getReadModel());
    const midThread = midReadModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(midThread?.session?.status).toBe("running");
    expect(midThread?.session?.activeTurnId).toBe("turn-midturn-lifecycle");

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-midturn-lifecycle"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-midturn-lifecycle"),
      status: "completed",
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("ignores auxiliary turn completions from a different provider thread", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-primary"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-primary"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === "turn-primary",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-aux"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-aux"),
      status: "completed",
    });

    await Effect.runPromise(Effect.sleep("40 millis"));
    const midReadModel = await Effect.runPromise(harness.engine.getReadModel());
    const midThread = midReadModel.threads.find(
      (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
    );
    expect(midThread?.session?.status).toBe("running");
    expect(midThread?.session?.activeTurnId).toBe("turn-primary");

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-primary"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-primary"),
      status: "completed",
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("ignores non-active turn completion when runtime omits thread id", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-guarded"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-guarded-main"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-guarded-main",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-guarded-other"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-guarded-other"),
      status: "completed",
    });

    await Effect.runPromise(Effect.sleep("40 millis"));
    const midReadModel = await Effect.runPromise(harness.engine.getReadModel());
    const midThread = midReadModel.threads.find(
      (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
    );
    expect(midThread?.session?.status).toBe("running");
    expect(midThread?.session?.activeTurnId).toBe("turn-guarded-main");

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-guarded-main"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-guarded-main"),
      status: "completed",
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("does not overwrite the parent providerThreadId when unknown child events fall back to the parent", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "thread.started",
      eventId: asEventId("evt-thread-started-root-provider-id"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        providerThreadId: "provider-thread-root-1",
      },
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.providerThreadId === "provider-thread-root-1",
    );

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-unknown-child-fallback"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      providerThreadId: "provider-thread-child-unresolved",
      turnId: asTurnId("turn-child-unresolved"),
    });

    await Effect.runPromise(Effect.sleep("40 millis"));
    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const parentThread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(parentThread?.session?.providerThreadId).toBe("provider-thread-root-1");
  });

  it("maps canonical content delta/item completed into finalized assistant messages", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-1"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-2"),
      itemId: asItemId("item-1"),
      payload: {
        streamKind: "assistant_text",
        delta: "hello",
      },
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-2"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-2"),
      itemId: asItemId("item-1"),
      payload: {
        streamKind: "assistant_text",
        delta: " world",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-2"),
      itemId: asItemId("item-1"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-1" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-1",
    );
    expect(message?.text).toBe("hello world");
    expect(message?.streaming).toBe(false);
  });

  it("uses assistant item completion detail when no assistant deltas were streamed", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-assistant-item-completed-no-delta"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-no-delta"),
      itemId: asItemId("item-no-delta"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "assistant-only final text",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-no-delta" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-no-delta",
    );
    expect(message?.text).toBe("assistant-only final text");
    expect(message?.streaming).toBe(false);
  });

  it("projects completed plan items into first-class proposed plans", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-plan-item-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-final"),
      payload: {
        planMarkdown: "## Ship plan\n\n- wire projection\n- render follow-up",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.proposedPlans.some(
        (proposedPlan: ProviderRuntimeTestProposedPlan) =>
          proposedPlan.id === "plan:thread-1:turn:turn-plan-final",
      ),
    );
    const proposedPlan = thread.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) => entry.id === "plan:thread-1:turn:turn-plan-final",
    );
    expect(proposedPlan?.planMarkdown).toBe("## Ship plan\n\n- wire projection\n- render follow-up");
  });

  it("finalizes buffered proposed-plan deltas into a first-class proposed plan on turn completion", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-plan-buffer"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-buffer"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === "turn-plan-buffer",
    );

    harness.emit({
      type: "turn.proposed.delta",
      eventId: asEventId("evt-plan-delta-1"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-buffer"),
      payload: {
        delta: "## Buffered plan\n\n- first",
      },
    });
    harness.emit({
      type: "turn.proposed.delta",
      eventId: asEventId("evt-plan-delta-2"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-buffer"),
      payload: {
        delta: "\n- second",
      },
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-plan-buffer"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-buffer"),
      payload: {
        state: "completed",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.proposedPlans.some(
        (proposedPlan: ProviderRuntimeTestProposedPlan) =>
          proposedPlan.id === "plan:thread-1:turn:turn-plan-buffer",
      ),
    );
    const proposedPlan = thread.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) => entry.id === "plan:thread-1:turn:turn-plan-buffer",
    );
    expect(proposedPlan?.planMarkdown).toBe("## Buffered plan\n\n- first\n- second");
  });

  it("buffers assistant deltas by default until completion", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffered"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered"),
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === "turn-buffered",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffered"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered"),
      itemId: asItemId("item-buffered"),
      payload: {
        streamKind: "assistant_text",
        delta: "buffer me",
      },
    });

    await Effect.runPromise(Effect.sleep("30 millis"));
    const midReadModel = await Effect.runPromise(harness.engine.getReadModel());
    const midThread = midReadModel.threads.find(
      (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
    );
    expect(
      midThread?.messages.some(
        (message: ProviderRuntimeTestMessage) => message.id === "assistant:item-buffered",
      ),
    ).toBe(false);

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-buffered"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered"),
      itemId: asItemId("item-buffered"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-buffered" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-buffered",
    );
    expect(message?.text).toBe("buffer me");
    expect(message?.streaming).toBe(false);
  });

  it("streams assistant deltas when thread.turn.start requests streaming mode", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-streaming-mode"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("message-streaming-mode"),
          role: "user",
          text: "stream please",
          attachments: [],
        },
        assistantDeliveryMode: "streaming",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await Effect.runPromise(Effect.sleep("30 millis"));

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-streaming-mode"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-mode"),
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-streaming-mode",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-streaming-mode"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-mode"),
      itemId: asItemId("item-streaming-mode"),
      payload: {
        streamKind: "assistant_text",
        delta: "hello live",
      },
    });

    const liveThread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-mode" &&
          message.streaming &&
          message.text === "hello live",
      ),
    );
    const liveMessage = liveThread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-streaming-mode",
    );
    expect(liveMessage?.streaming).toBe(true);

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-streaming-mode"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-mode"),
      itemId: asItemId("item-streaming-mode"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const finalThread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-mode" && !message.streaming,
      ),
    );
    const finalMessage = finalThread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-streaming-mode",
    );
    expect(finalMessage?.text).toBe("hello live");
    expect(finalMessage?.streaming).toBe(false);
  });

  it("spills oversized buffered deltas and still finalizes full assistant text", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const oversizedText = "x".repeat(40_000);

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffer-spill"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffer-spill"),
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-buffer-spill",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffer-spill"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffer-spill"),
      itemId: asItemId("item-buffer-spill"),
      payload: {
        streamKind: "assistant_text",
        delta: oversizedText,
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-buffer-spill"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffer-spill"),
      itemId: asItemId("item-buffer-spill"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-buffer-spill" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-buffer-spill",
    );
    expect(message?.text.length).toBe(oversizedText.length);
    expect(message?.text).toBe(oversizedText);
    expect(message?.streaming).toBe(false);
  });

  it("does not duplicate assistant completion when item.completed is followed by turn.completed", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-for-complete-dedup"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-complete-dedup"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-complete-dedup",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-for-complete-dedup"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-complete-dedup"),
      itemId: asItemId("item-complete-dedup"),
      payload: {
        streamKind: "assistant_text",
        delta: "done",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-for-complete-dedup"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-complete-dedup"),
      itemId: asItemId("item-complete-dedup"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-for-complete-dedup"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-complete-dedup"),
      payload: {
        state: "completed",
      },
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "ready" &&
        thread.session?.activeTurnId === null &&
        thread.messages.some(
          (message: ProviderRuntimeTestMessage) =>
            message.id === "assistant:item-complete-dedup" && !message.streaming,
        ),
    );

    const events = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      ),
    );
    const completionEvents = events.filter((event) => {
      if (event.type !== "thread.message-sent") {
        return false;
      }
      return (
        event.payload.messageId === "assistant:item-complete-dedup" &&
        event.payload.streaming === false
      );
    });
    expect(completionEvents).toHaveLength(1);
  });

  it("maps canonical request events into approval activities with requestKind", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "request.opened",
      eventId: asEventId("evt-request-opened"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      requestId: ApprovalRequestId.makeUnsafe("req-open"),
      payload: {
        requestType: "command_execution_approval",
        detail: "pwd",
      },
    });

    harness.emit({
      type: "request.resolved",
      eventId: asEventId("evt-request-resolved"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      requestId: ApprovalRequestId.makeUnsafe("req-open"),
      payload: {
        requestType: "command_execution_approval",
        decision: "accept",
      },
    });

    await waitForThread(
      harness.engine,
      (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "approval.requested",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "approval.resolved",
        ),
    );

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread).toBeDefined();

    const requested = thread?.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-request-opened",
    );
    const requestedPayload =
      requested?.payload && typeof requested.payload === "object"
        ? (requested.payload as Record<string, unknown>)
        : undefined;
    expect(requestedPayload?.requestKind).toBe("command");
    expect(requestedPayload?.requestType).toBe("command_execution_approval");

    const resolved = thread?.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-request-resolved",
    );
    const resolvedPayload =
      resolved?.payload && typeof resolved.payload === "object"
        ? (resolved.payload as Record<string, unknown>)
        : undefined;
    expect(resolvedPayload?.requestKind).toBe("command");
    expect(resolvedPayload?.requestType).toBe("command_execution_approval");
  });

  it("maps runtime.error into errored session state", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "runtime.error",
      eventId: asEventId("evt-runtime-error"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-3"),
      payload: {
        message: "runtime exploded",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === "turn-3" &&
        entry.session?.lastError === "runtime exploded",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("runtime exploded");
  });

  it("maps session/thread lifecycle and item.started into session/activity projections", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "session.started",
      eventId: asEventId("evt-session-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      message: "session started",
    });
    harness.emit({
      type: "thread.started",
      eventId: asEventId("evt-thread-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        providerThreadId: "provider-thread-1",
        source: {
          kind: "subAgentThreadSpawn",
          parentProviderThreadId: "provider-parent-1",
          depth: 1,
          agentNickname: "Atlas",
          agentRole: "explorer",
        },
      },
    });
    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-tool-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-9"),
      payload: {
        itemType: "command_execution",
        status: "in_progress",
        title: "Read file",
        detail: "/tmp/file.ts",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "ready" &&
        entry.session?.activeTurnId === null &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "tool.started",
        ),
    );

    expect(thread.session?.status).toBe("ready");
    expect(
      thread.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "tool.started",
      ),
    ).toBe(true);
  });

  it("consumes P1 runtime events into thread metadata, diff checkpoints, and activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "thread.metadata.updated",
      eventId: asEventId("evt-thread-metadata-updated"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        name: "Renamed by provider",
        metadata: { source: "provider" },
      },
    });

    harness.emit({
      type: "turn.plan.updated",
      eventId: asEventId("evt-turn-plan-updated"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-p1"),
      payload: {
        explanation: "Working through the plan",
        plan: [
          { step: "Inspect files", status: "completed" },
          { step: "Apply patch", status: "in_progress" },
        ],
      },
    });

    harness.emit({
      type: "item.updated",
      eventId: asEventId("evt-item-updated"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-p1"),
      itemId: asItemId("item-p1-tool"),
      payload: {
        itemType: "command_execution",
        status: "in_progress",
        title: "Run tests",
        detail: "bun test",
        data: { pid: 123 },
      },
    });

    harness.emit({
      type: "runtime.warning",
      eventId: asEventId("evt-runtime-warning"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-p1"),
      payload: {
        message: "Provider got slow",
        detail: { latencyMs: 1500 },
      },
    });

    harness.emit({
      type: "turn.diff.updated",
      eventId: asEventId("evt-turn-diff-updated"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-p1"),
      itemId: asItemId("item-p1-assistant"),
      payload: {
        unifiedDiff: "diff --git a/file.txt b/file.txt\n+hello\n",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.title === "Renamed by provider" &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "turn.plan.updated",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "tool.updated",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "runtime.warning",
        ) &&
        entry.checkpoints.some(
          (checkpoint: ProviderRuntimeTestCheckpoint) => checkpoint.turnId === "turn-p1",
        ),
    );

    expect(thread.title).toBe("Renamed by provider");

    const planActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-turn-plan-updated",
    );
    const planPayload =
      planActivity?.payload && typeof planActivity.payload === "object"
        ? (planActivity.payload as Record<string, unknown>)
        : undefined;
    expect(planActivity?.kind).toBe("turn.plan.updated");
    expect(Array.isArray(planPayload?.plan)).toBe(true);

    const toolUpdate = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-item-updated",
    );
    const toolUpdatePayload =
      toolUpdate?.payload && typeof toolUpdate.payload === "object"
        ? (toolUpdate.payload as Record<string, unknown>)
        : undefined;
    expect(toolUpdate?.kind).toBe("tool.updated");
    expect(toolUpdatePayload?.itemType).toBe("command_execution");
    expect(toolUpdatePayload?.status).toBe("in_progress");

    const warning = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-runtime-warning",
    );
    const warningPayload =
      warning?.payload && typeof warning.payload === "object"
        ? (warning.payload as Record<string, unknown>)
        : undefined;
    expect(warning?.kind).toBe("runtime.warning");
    expect(warningPayload?.message).toBe("Provider got slow");

    const checkpoint = thread.checkpoints.find(
      (entry: ProviderRuntimeTestCheckpoint) => entry.turnId === "turn-p1",
    );
    expect(checkpoint?.status).toBe("missing");
    expect(checkpoint?.assistantMessageId).toBe("assistant:item-p1-assistant");
    expect(checkpoint?.checkpointRef).toBe("provider-diff:evt-turn-diff-updated");
  });

  it("projects Codex task lifecycle chunks into thread activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "task.started",
      eventId: asEventId("evt-task-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        taskId: "turn-task-1",
        taskType: "plan",
      },
    });

    harness.emit({
      type: "task.progress",
      eventId: asEventId("evt-task-progress"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        taskId: "turn-task-1",
        description: "Comparing the desktop rollout chunks to the app-server stream.",
      },
    });

    harness.emit({
      type: "task.completed",
      eventId: asEventId("evt-task-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        taskId: "turn-task-1",
        status: "completed",
        summary: "<proposed_plan>\n# Plan title\n</proposed_plan>",
      },
    });
    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-task-proposed-plan-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        planMarkdown: "# Plan title",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "task.completed",
        ) &&
        entry.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === "plan:thread-1:turn:turn-task-1",
        ),
    );

    const started = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-task-started",
    );
    const progress = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-task-progress",
    );
    const completed = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-task-completed",
    );

    const progressPayload =
      progress?.payload && typeof progress.payload === "object"
        ? (progress.payload as Record<string, unknown>)
        : undefined;
    const completedPayload =
      completed?.payload && typeof completed.payload === "object"
        ? (completed.payload as Record<string, unknown>)
        : undefined;

    expect(started?.kind).toBe("task.started");
    expect(started?.summary).toBe("Plan task started");
    expect(progress?.kind).toBe("task.progress");
    expect(progressPayload?.detail).toBe(
      "Comparing the desktop rollout chunks to the app-server stream.",
    );
    expect(completed?.kind).toBe("task.completed");
    expect(completedPayload?.detail).toBe("<proposed_plan>\n# Plan title\n</proposed_plan>");
    expect(
      thread.proposedPlans.find(
        (entry: ProviderRuntimeTestProposedPlan) => entry.id === "plan:thread-1:turn:turn-task-1",
      )?.planMarkdown,
    ).toBe("# Plan title");
  });

  it("projects structured user input request and resolution as thread activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "user-input.requested",
      eventId: asEventId("evt-user-input-requested"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-user-input"),
      requestId: ApprovalRequestId.makeUnsafe("req-user-input-1"),
      payload: {
        questions: [
          {
            id: "sandbox_mode",
            header: "Sandbox",
            question: "Which mode should be used?",
            options: [
              {
                label: "workspace-write",
                description: "Allow workspace writes only",
              },
            ],
          },
        ],
      },
    });

    harness.emit({
      type: "user-input.resolved",
      eventId: asEventId("evt-user-input-resolved"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-user-input"),
      requestId: ApprovalRequestId.makeUnsafe("req-user-input-1"),
      payload: {
        answers: {
          sandbox_mode: "workspace-write",
        },
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "user-input.requested",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "user-input.resolved",
        ),
    );

    const requested = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-user-input-requested",
    );
    expect(requested?.kind).toBe("user-input.requested");

    const resolved = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-user-input-resolved",
    );
    const resolvedPayload =
      resolved?.payload && typeof resolved.payload === "object"
        ? (resolved.payload as Record<string, unknown>)
        : undefined;
    expect(resolved?.kind).toBe("user-input.resolved");
    expect(resolvedPayload?.answers).toEqual({
      sandbox_mode: "workspace-write",
    });
  });

  it("continues processing runtime events after a single event handler failure", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-invalid-delta"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-invalid"),
      itemId: asItemId("item-invalid"),
      payload: {
        streamKind: "assistant_text",
        delta: undefined,
      },
    } as unknown as ProviderRuntimeEvent);

    harness.emit({
      type: "runtime.error",
      eventId: asEventId("evt-runtime-error-after-failure"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-after-failure"),
      payload: {
        message: "runtime still processed",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === "turn-after-failure" &&
        entry.session?.lastError === "runtime still processed",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("runtime still processed");
  });

  it("materializes spawned subagent threads and persists their provider binding", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "thread.started",
      eventId: asEventId("evt-thread-child-started"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: now,
      payload: {
        providerThreadId: "provider-thread-child-1",
        name: "Child review",
        preview: "Investigate the failing test",
        source: {
          kind: "subAgentThreadSpawn",
          parentProviderThreadId: "provider-thread-root-1",
          depth: 1,
          agentNickname: "Confucius",
          agentRole: "reviewer",
        },
      },
    });

    const childThread = await (async () => {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const readModel = await Effect.runPromise(harness.engine.getReadModel());
        const found = readModel.threads.find(
          (thread) => thread.providerThreadId === "provider-thread-child-1",
        );
        if (found) {
          return found;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("Timed out waiting for child thread materialization");
    })();

    expect(childThread.parentThreadId).toBe("thread-1");
    expect(childThread.origin).toEqual({
      kind: "subAgentThreadSpawn",
      parentProviderThreadId: "provider-thread-root-1",
      depth: 1,
      agentNickname: "Confucius",
      agentRole: "reviewer",
    });
    expect(childThread.title).toBe("Child review");
    expect(childThread.session?.status).toBe("ready");
    expect(childThread.session?.providerThreadId).toBe("provider-thread-child-1");

    const binding = await Effect.runPromise(
      harness.providerSessionRuntimeRepository.getByThreadId({ threadId: childThread.id }),
    );
    expect(binding._tag).toBe("Some");
    if (binding._tag === "Some") {
      expect(binding.value.providerName).toBe("codex");
      expect(binding.value.resumeCursor).toEqual({ threadId: "provider-thread-child-1" });
      expect(binding.value.runtimeMode).toBe("approval-required");
    }
  });

  it("materializes spawned subagent threads from the top-level providerThreadId when payload metadata omits it", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "thread.started",
      eventId: asEventId("evt-thread-child-started-top-level-provider-thread"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      providerThreadId: "provider-thread-child-top-level-only",
      createdAt: now,
      payload: {
        name: "Child top level",
        preview: "Top level provider thread id",
        source: {
          kind: "subAgentThreadSpawn",
          parentProviderThreadId: "provider-thread-root-1",
          depth: 1,
          agentNickname: "Hypatia",
          agentRole: "reviewer",
        },
      },
    } as unknown as ProviderRuntimeEvent);

    const childThread = await (async () => {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const readModel = await Effect.runPromise(harness.engine.getReadModel());
        const found = readModel.threads.find(
          (thread) => thread.providerThreadId === "provider-thread-child-top-level-only",
        );
        if (found) {
          return found;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("Timed out waiting for top-level providerThreadId child materialization");
    })();

    expect(childThread.parentThreadId).toBe("thread-1");
    expect(childThread.title).toBe("Child top level");
    expect(childThread.origin).toEqual({
      kind: "subAgentThreadSpawn",
      parentProviderThreadId: "provider-thread-root-1",
      depth: 1,
      agentNickname: "Hypatia",
      agentRole: "reviewer",
    });
  });

  it("routes child turn lifecycle events by providerThreadId without disturbing the parent", async () => {
    const harness = await createHarness();
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.materialize",
        commandId: CommandId.makeUnsafe("cmd-thread-materialize-routing-child"),
        threadId: ThreadId.makeUnsafe("thread-child-routing"),
        projectId: asProjectId("project-1"),
        title: "Child Routing",
        model: "gpt-5-codex",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        providerThreadId: "provider-thread-child-routing",
        parentThreadId: ThreadId.makeUnsafe("thread-1"),
        origin: {
          kind: "subAgentThreadSpawn",
          parentProviderThreadId: "provider-thread-root-1",
        },
        createdAt,
      }),
    );

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-child-turn-started"),
      provider: "codex",
      createdAt,
      threadId: asThreadId("thread-1"),
      providerThreadId: "provider-thread-child-routing",
      turnId: asTurnId("turn-child-1"),
    });

    const childRunning = await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-child-1",
      2000,
      "thread-child-routing",
    );
    expect(childRunning.session?.providerThreadId).toBe("provider-thread-child-routing");

    const parentReadModel = await Effect.runPromise(harness.engine.getReadModel());
    const parentThread = parentReadModel.threads.find((thread) => thread.id === asThreadId("thread-1"));
    expect(parentThread?.session?.status).toBe("ready");
    expect(parentThread?.session?.activeTurnId).toBeNull();

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-child-turn-completed"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      providerThreadId: "provider-thread-child-routing",
      turnId: asTurnId("turn-child-1"),
      payload: {
        state: "completed",
      },
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
      2000,
      "thread-child-routing",
    );
  });

  it("routes child assistant output and activities by providerThreadId", async () => {
    const harness = await createHarness();
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.materialize",
        commandId: CommandId.makeUnsafe("cmd-thread-materialize-routing-message"),
        threadId: ThreadId.makeUnsafe("thread-child-message"),
        projectId: asProjectId("project-1"),
        title: "Child Message",
        model: "gpt-5-codex",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        providerThreadId: "provider-thread-child-message",
        parentThreadId: ThreadId.makeUnsafe("thread-1"),
        origin: {
          kind: "subAgentThreadSpawn",
          parentProviderThreadId: "provider-thread-root-1",
        },
        createdAt,
      }),
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-child-content-delta"),
      provider: "codex",
      createdAt,
      threadId: asThreadId("thread-1"),
      providerThreadId: "provider-thread-child-message",
      turnId: asTurnId("turn-child-message"),
      itemId: asItemId("item-child-message"),
      payload: {
        streamKind: "assistant_text",
        delta: "hello from child",
      },
    });

    harness.emit({
      type: "turn.plan.updated",
      eventId: asEventId("evt-child-plan-updated"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      providerThreadId: "provider-thread-child-message",
      turnId: asTurnId("turn-child-message"),
      payload: {
        explanation: "Child plan",
        plan: [{ step: "Inspect files", status: "inProgress" }],
      },
    });

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-child-item-completed"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      providerThreadId: "provider-thread-child-message",
      turnId: asTurnId("turn-child-message"),
      itemId: asItemId("item-child-message"),
      payload: {
        itemType: "assistant_message",
        title: "Assistant message",
        status: "completed",
        detail: "hello from child",
      },
    });

    const childThread = await waitForThread(
      harness.engine,
      (thread) =>
        thread.messages.some(
          (message) => message.role === "assistant" && message.text.includes("hello from child"),
        ) &&
        thread.activities.some((activity) => activity.kind === "turn.plan.updated"),
      2000,
      "thread-child-message",
    );

    expect(
      childThread.messages.some((message) => message.role === "assistant"),
    ).toBe(true);
    expect(
      childThread.activities.some((activity) => activity.kind === "turn.plan.updated"),
    ).toBe(true);

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const parentThread = readModel.threads.find((thread) => thread.id === asThreadId("thread-1"));
    expect(parentThread?.messages).toHaveLength(0);
    expect(parentThread?.activities.some((activity) => activity.kind === "turn.plan.updated")).toBe(false);
  });

  it("keeps interleaved parent and child approval activities isolated by thread", async () => {
    const harness = await createHarness();
    const createdAt = new Date().toISOString();
    await materializeChildThread(harness, {
      threadId: "thread-child-approval-interleaved",
      providerThreadId: "provider-thread-child-approval-interleaved",
      createdAt,
      title: "Child Approval Interleaved",
    });

    harness.emit({
      type: "request.opened",
      eventId: asEventId("evt-parent-approval-opened"),
      provider: "codex",
      createdAt,
      threadId: asThreadId("thread-1"),
      requestId: ApprovalRequestId.makeUnsafe("req-parent-approval"),
      payload: {
        requestType: "command_execution_approval",
        detail: "pwd",
      },
    });
    harness.emit({
      type: "request.opened",
      eventId: asEventId("evt-child-approval-opened"),
      provider: "codex",
      createdAt,
      threadId: asThreadId("thread-1"),
      providerThreadId: "provider-thread-child-approval-interleaved",
      requestId: ApprovalRequestId.makeUnsafe("req-child-approval"),
      payload: {
        requestType: "command_execution_approval",
        detail: "ls",
      },
    });
    harness.emit({
      type: "request.resolved",
      eventId: asEventId("evt-child-approval-resolved"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      providerThreadId: "provider-thread-child-approval-interleaved",
      requestId: ApprovalRequestId.makeUnsafe("req-child-approval"),
      payload: {
        requestType: "command_execution_approval",
        decision: "accept",
      },
    });
    harness.emit({
      type: "request.resolved",
      eventId: asEventId("evt-parent-approval-resolved"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      requestId: ApprovalRequestId.makeUnsafe("req-parent-approval"),
      payload: {
        requestType: "command_execution_approval",
        decision: "reject",
      },
    });

    const parentThread = await waitForThread(
      harness.engine,
      (thread) =>
        thread.activities.some(
          (activity) =>
            activity.kind === "approval.requested" &&
            typeof activity.payload === "object" &&
            activity.payload !== null &&
            (activity.payload as Record<string, unknown>).requestId === "req-parent-approval",
        ) &&
        thread.activities.some(
          (activity) =>
            activity.kind === "approval.resolved" &&
            typeof activity.payload === "object" &&
            activity.payload !== null &&
            (activity.payload as Record<string, unknown>).requestId === "req-parent-approval",
        ),
      2000,
      "thread-1",
    );
    const childThread = await waitForThread(
      harness.engine,
      (thread) =>
        thread.activities.some(
          (activity) =>
            activity.kind === "approval.requested" &&
            typeof activity.payload === "object" &&
            activity.payload !== null &&
            (activity.payload as Record<string, unknown>).requestId === "req-child-approval",
        ) &&
        thread.activities.some(
          (activity) =>
            activity.kind === "approval.resolved" &&
            typeof activity.payload === "object" &&
            activity.payload !== null &&
            (activity.payload as Record<string, unknown>).requestId === "req-child-approval",
        ),
      2000,
      "thread-child-approval-interleaved",
    );

    expect(
      parentThread.activities.some(
        (activity) =>
          typeof activity.payload === "object" &&
          activity.payload !== null &&
          (activity.payload as Record<string, unknown>).requestId === "req-child-approval",
      ),
    ).toBe(false);
    expect(
      childThread.activities.some(
        (activity) =>
          typeof activity.payload === "object" &&
          activity.payload !== null &&
          (activity.payload as Record<string, unknown>).requestId === "req-parent-approval",
      ),
    ).toBe(false);
    expect(parentThread.providerThreadId ?? null).not.toBe(
      "provider-thread-child-approval-interleaved",
    );
    expect(childThread.providerThreadId).toBe("provider-thread-child-approval-interleaved");
  });

  it("keeps interleaved parent and child structured user-input activities isolated by thread", async () => {
    const harness = await createHarness();
    const createdAt = new Date().toISOString();
    await materializeChildThread(harness, {
      threadId: "thread-child-user-input-interleaved",
      providerThreadId: "provider-thread-child-user-input-interleaved",
      createdAt,
      title: "Child User Input Interleaved",
    });

    harness.emit({
      type: "user-input.requested",
      eventId: asEventId("evt-parent-user-input-requested"),
      provider: "codex",
      createdAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-parent-user-input"),
      requestId: ApprovalRequestId.makeUnsafe("req-parent-user-input"),
      payload: {
        questions: [
          {
            id: "sandbox_mode",
            header: "Sandbox",
            question: "Pick a sandbox mode",
            options: [
              {
                label: "read-only",
                description: "No writes",
              },
            ],
          },
        ],
      },
    });
    harness.emit({
      type: "user-input.requested",
      eventId: asEventId("evt-child-user-input-requested"),
      provider: "codex",
      createdAt,
      threadId: asThreadId("thread-1"),
      providerThreadId: "provider-thread-child-user-input-interleaved",
      turnId: asTurnId("turn-child-user-input"),
      requestId: ApprovalRequestId.makeUnsafe("req-child-user-input"),
      payload: {
        questions: [
          {
            id: "sandbox_mode",
            header: "Sandbox",
            question: "Pick a sandbox mode",
            options: [
              {
                label: "workspace-write",
                description: "Allow workspace writes only",
              },
            ],
          },
        ],
      },
    });
    harness.emit({
      type: "user-input.resolved",
      eventId: asEventId("evt-child-user-input-resolved"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      providerThreadId: "provider-thread-child-user-input-interleaved",
      turnId: asTurnId("turn-child-user-input"),
      requestId: ApprovalRequestId.makeUnsafe("req-child-user-input"),
      payload: {
        answers: {
          sandbox_mode: "workspace-write",
        },
      },
    });
    harness.emit({
      type: "user-input.resolved",
      eventId: asEventId("evt-parent-user-input-resolved"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-parent-user-input"),
      requestId: ApprovalRequestId.makeUnsafe("req-parent-user-input"),
      payload: {
        answers: {
          sandbox_mode: "read-only",
        },
      },
    });

    const parentThread = await waitForThread(
      harness.engine,
      (thread) =>
        thread.activities.some(
          (activity) =>
            activity.kind === "user-input.requested" &&
            typeof activity.payload === "object" &&
            activity.payload !== null &&
            (activity.payload as Record<string, unknown>).requestId === "req-parent-user-input",
        ) &&
        thread.activities.some(
          (activity) =>
            activity.kind === "user-input.resolved" &&
            typeof activity.payload === "object" &&
            activity.payload !== null &&
            (activity.payload as Record<string, unknown>).requestId === "req-parent-user-input",
        ),
      2000,
      "thread-1",
    );
    const childThread = await waitForThread(
      harness.engine,
      (thread) =>
        thread.activities.some(
          (activity) =>
            activity.kind === "user-input.requested" &&
            typeof activity.payload === "object" &&
            activity.payload !== null &&
            (activity.payload as Record<string, unknown>).requestId === "req-child-user-input",
        ) &&
        thread.activities.some(
          (activity) =>
            activity.kind === "user-input.resolved" &&
            typeof activity.payload === "object" &&
            activity.payload !== null &&
            (activity.payload as Record<string, unknown>).requestId === "req-child-user-input",
        ),
      2000,
      "thread-child-user-input-interleaved",
    );

    expect(
      parentThread.activities.some(
        (activity) =>
          typeof activity.payload === "object" &&
          activity.payload !== null &&
          (activity.payload as Record<string, unknown>).requestId === "req-child-user-input",
      ),
    ).toBe(false);
    expect(
      childThread.activities.some(
        (activity) =>
          typeof activity.payload === "object" &&
          activity.payload !== null &&
          (activity.payload as Record<string, unknown>).requestId === "req-parent-user-input",
      ),
    ).toBe(false);
    expect(parentThread.providerThreadId ?? null).not.toBe(
      "provider-thread-child-user-input-interleaved",
    );
    expect(childThread.providerThreadId).toBe("provider-thread-child-user-input-interleaved");
  });

  it("materializes collab subagent receiver threads from tool-call lifecycle events", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-collab-subagent-started"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: now,
      turnId: asTurnId("turn-collab-root"),
      itemId: asItemId("call-collab-1"),
      payload: {
        itemType: "collab_agent_tool_call",
        status: "inProgress",
        data: {
          item: {
            type: "collabAgentToolCall",
            id: "call-collab-1",
            tool: "wait",
            status: "inProgress",
            senderThreadId: "provider-thread-root-1",
            receiverThreadIds: ["provider-thread-child-collab-1"],
            prompt: "Subagent, inspect this file and report back.",
            receiverAgents: [
              {
                threadId: "provider-thread-child-collab-1",
                agentNickname: "Pauli",
              },
            ],
            agentsStates: {},
          },
          threadId: "provider-thread-root-1",
          turnId: "turn-collab-root",
        },
      },
    });

    const childThread = await (async () => {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const readModel = await Effect.runPromise(harness.engine.getReadModel());
        const found = readModel.threads.find(
          (thread) => thread.providerThreadId === "provider-thread-child-collab-1",
        );
        if (found) {
          return found;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("Timed out waiting for collab child thread materialization");
    })();

    expect(childThread.parentThreadId).toBe("thread-1");
    expect(childThread.origin).toEqual({
      kind: "subAgentThreadSpawn",
      parentProviderThreadId: "provider-thread-root-1",
    });
    expect(childThread.title).toBe("Pauli");
    expect(childThread.session).toBeNull();
    expect(childThread.messages).toEqual([
      expect.objectContaining({
        role: "user",
        text: "Subagent, inspect this file and report back.",
        turnId: null,
      }),
    ]);

    const binding = await Effect.runPromise(
      harness.providerSessionRuntimeRepository.getByThreadId({ threadId: childThread.id }),
    );
    expect(binding._tag).toBe("Some");
    if (binding._tag === "Some") {
      expect(binding.value.providerName).toBe("codex");
      expect(binding.value.resumeCursor).toEqual({ threadId: "provider-thread-child-collab-1" });
      expect(binding.value.runtimeMode).toBe("approval-required");
    }
  });

  it("materializes collab subagent receiver threads from unwrapped item payloads", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-collab-subagent-completed-unwrapped"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: now,
      turnId: asTurnId("turn-collab-root-unwrapped"),
      itemId: asItemId("call-collab-unwrapped-1"),
      payload: {
        itemType: "collab_agent_tool_call",
        status: "completed",
        data: {
          type: "collabAgentToolCall",
          id: "call-collab-unwrapped-1",
          tool: "spawnAgent",
          status: "completed",
          senderThreadId: "provider-thread-root-1",
          receiverThreadIds: ["provider-thread-child-collab-unwrapped-1"],
          prompt: "hello",
          newAgentNickname: "Ampere",
          agentsStates: {
            "provider-thread-child-collab-unwrapped-1": {
              status: "pendingInit",
              message: null,
            },
          },
        },
      },
    });

    const childThread = await (async () => {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const readModel = await Effect.runPromise(harness.engine.getReadModel());
        const found = readModel.threads.find(
          (thread) => thread.providerThreadId === "provider-thread-child-collab-unwrapped-1",
        );
        if (found) {
          return found;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("Timed out waiting for unwrapped collab child thread materialization");
    })();

    expect(childThread.parentThreadId).toBe("thread-1");
    expect(childThread.origin).toEqual({
      kind: "subAgentThreadSpawn",
      parentProviderThreadId: "provider-thread-root-1",
    });
    expect(childThread.title).toBe("Ampere");
    expect(childThread.messages).toEqual([
      expect.objectContaining({
        role: "user",
        text: "hello",
        turnId: null,
      }),
    ]);
  });

  it("upgrades placeholder child titles when richer thread.started metadata arrives later", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-collab-subagent-title-upgrade"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: now,
      turnId: asTurnId("turn-collab-title-upgrade"),
      itemId: asItemId("call-collab-title-upgrade"),
      payload: {
        itemType: "collab_agent_tool_call",
        status: "completed",
        data: {
          type: "collabAgentToolCall",
          id: "call-collab-title-upgrade",
          tool: "spawnAgent",
          status: "completed",
          senderThreadId: "provider-thread-root-1",
          receiverThreadIds: ["provider-thread-child-title-upgrade"],
          prompt: "say hello",
          agentsStates: {},
        },
      },
    });

    const placeholderChild = await (async () => {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const readModel = await Effect.runPromise(harness.engine.getReadModel());
        const found = readModel.threads.find(
          (thread) => thread.providerThreadId === "provider-thread-child-title-upgrade",
        );
        if (found) {
          return found;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("Timed out waiting for placeholder child thread");
    })();

    expect(placeholderChild.title).toBe("say hello");

    harness.emit({
      type: "thread.started",
      eventId: asEventId("evt-thread-child-title-upgrade"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      providerThreadId: "provider-thread-child-title-upgrade",
      createdAt: new Date().toISOString(),
      payload: {
        providerThreadId: "provider-thread-child-title-upgrade",
        name: null,
        preview: "",
        source: {
          kind: "subAgentThreadSpawn",
          parentProviderThreadId: "provider-thread-root-1",
          agentNickname: "Ampere",
          agentRole: "generalist",
        },
      },
    });

    const upgradedChild = await waitForThread(
      harness.engine,
      (thread) => thread.title === "Ampere",
      2000,
      placeholderChild.id,
    );
    expect(upgradedChild.title).toBe("Ampere");
  });

  it("upgrades placeholder collab child titles when later collab events include receiver nicknames", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-collab-subagent-title-placeholder"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: now,
      turnId: asTurnId("turn-collab-title-placeholder"),
      itemId: asItemId("call-collab-title-placeholder"),
      payload: {
        itemType: "collab_agent_tool_call",
        status: "inProgress",
        data: {
          item: {
            type: "collabAgentToolCall",
            id: "call-collab-title-placeholder",
            tool: "spawnAgent",
            status: "inProgress",
            senderThreadId: "provider-thread-root-1",
            receiverThreadIds: ["provider-thread-child-collab-title-upgrade"],
            prompt: "say hello",
            agentsStates: {},
          },
        },
      },
    });

    const childThread = await (async () => {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const readModel = await Effect.runPromise(harness.engine.getReadModel());
        const found = readModel.threads.find(
          (thread) => thread.providerThreadId === "provider-thread-child-collab-title-upgrade",
        );
        if (found) {
          return found;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("Timed out waiting for collab child thread");
    })();

    expect(childThread.title).toBe("say hello");

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-collab-subagent-title-upgrade-later"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: new Date().toISOString(),
      turnId: asTurnId("turn-collab-title-upgrade"),
      itemId: asItemId("call-collab-title-upgrade-later"),
      payload: {
        itemType: "collab_agent_tool_call",
        status: "completed",
        data: {
          item: {
            type: "collabAgentToolCall",
            id: "call-collab-title-upgrade-later",
            tool: "wait",
            status: "completed",
            senderThreadId: "provider-thread-root-1",
            receiverThreadIds: ["provider-thread-child-collab-title-upgrade"],
            receiverAgents: [
              {
                threadId: "provider-thread-child-collab-title-upgrade",
                agentNickname: "Ampere",
              },
            ],
            prompt: "say hello",
            agentsStates: {},
          },
        },
      },
    });

    const upgradedChild = await waitForThread(
      harness.engine,
      (thread) => thread.title === "Ampere",
      2000,
      childThread.id,
    );
    expect(upgradedChild.title).toBe("Ampere");
  });

  it("backfills the collab prompt onto an existing child thread without duplicating it", async () => {
    const harness = await createHarness();
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.materialize",
        commandId: CommandId.makeUnsafe("cmd-thread-materialize-existing-collab-child"),
        threadId: ThreadId.makeUnsafe("thread-existing-collab-child"),
        projectId: asProjectId("project-1"),
        title: "Subagent",
        model: "gpt-5-codex",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        providerThreadId: "provider-thread-existing-collab-child",
        parentThreadId: ThreadId.makeUnsafe("thread-1"),
        origin: {
          kind: "subAgentThreadSpawn",
          parentProviderThreadId: "provider-thread-root-1",
        },
        createdAt,
      }),
    );

    const prompt = "Review the failing snapshot and explain the mismatch.";
    const emitPromptEvent = () =>
      harness.emit({
        type: "item.completed",
        eventId: asEventId(`evt-collab-existing-child-prompt-${crypto.randomUUID()}`),
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        turnId: asTurnId("turn-collab-existing-child-prompt"),
        itemId: asItemId(`call-collab-existing-child-prompt-${crypto.randomUUID()}`),
        payload: {
          itemType: "collab_agent_tool_call",
          status: "completed",
          data: {
            item: {
              type: "collabAgentToolCall",
              id: "call-collab-existing-child-prompt",
              tool: "wait",
              status: "completed",
              senderThreadId: "provider-thread-root-1",
              receiverThreadIds: ["provider-thread-existing-collab-child"],
              prompt,
              agentsStates: {},
            },
          },
        },
      });

    emitPromptEvent();

    const withPrompt = await waitForThread(
      harness.engine,
      (thread) =>
        thread.messages.some(
          (message) => message.role === "user" && message.turnId === null && message.text === prompt,
        ),
      2000,
      "thread-existing-collab-child",
    );

    expect(
      withPrompt.messages.filter(
        (message) => message.role === "user" && message.turnId === null && message.text === prompt,
      ),
    ).toHaveLength(1);

    emitPromptEvent();

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const childThread = readModel.threads.find(
      (thread) => thread.id === ThreadId.makeUnsafe("thread-existing-collab-child"),
    );
    expect(
      childThread?.messages.filter(
        (message) => message.role === "user" && message.turnId === null && message.text === prompt,
      ),
    ).toHaveLength(1);
  });

  it("falls back to the first prompt line for collab child titles when no nickname is available", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-collab-subagent-prompt-title"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: now,
      turnId: asTurnId("turn-collab-prompt-title"),
      itemId: asItemId("call-collab-prompt-title"),
      payload: {
        itemType: "collab_agent_tool_call",
        status: "completed",
        data: {
          type: "collabAgentToolCall",
          id: "call-collab-prompt-title",
          tool: "spawnAgent",
          status: "completed",
          senderThreadId: "provider-thread-root-1",
          receiverThreadIds: ["provider-thread-child-prompt-title"],
          prompt: "Write a short original limerick about coding for Ratul and return only the limerick.\nKeep it playful.",
          agentsStates: {},
        },
      },
    });

    const childThread = await (async () => {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const readModel = await Effect.runPromise(harness.engine.getReadModel());
        const found = readModel.threads.find(
          (thread) => thread.providerThreadId === "provider-thread-child-prompt-title",
        );
        if (found) {
          return found;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("Timed out waiting for prompt-title child thread");
    })();

    expect(childThread.title).toBe(
      "Write a short original limerick about coding for Ratul and return only the limer",
    );
  });

  it("parents nested collab children under the sender thread when it already exists locally", async () => {
    const harness = await createHarness();
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.materialize",
        commandId: CommandId.makeUnsafe("cmd-thread-materialize-nested-parent"),
        threadId: ThreadId.makeUnsafe("thread-child-parent"),
        projectId: asProjectId("project-1"),
        title: "Child Parent",
        model: "gpt-5-codex",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        providerThreadId: "provider-thread-child-parent",
        parentThreadId: ThreadId.makeUnsafe("thread-1"),
        origin: {
          kind: "subAgentThreadSpawn",
          parentProviderThreadId: "provider-thread-root-1",
        },
        createdAt,
      }),
    );

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-collab-grandchild"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt,
      turnId: asTurnId("turn-collab-grandchild"),
      itemId: asItemId("call-collab-grandchild"),
      payload: {
        itemType: "collab_agent_tool_call",
        status: "completed",
        data: {
          item: {
            type: "collabAgentToolCall",
            id: "call-collab-grandchild",
            tool: "spawnAgent",
            status: "completed",
            senderThreadId: "provider-thread-child-parent",
            receiverThreadIds: ["provider-thread-grandchild-1"],
            prompt: "hello",
            agentsStates: {},
          },
          threadId: "provider-thread-root-1",
          turnId: "turn-collab-grandchild",
        },
      },
    });

    const grandchildThread = await (async () => {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const readModel = await Effect.runPromise(harness.engine.getReadModel());
        const found = readModel.threads.find(
          (thread) => thread.providerThreadId === "provider-thread-grandchild-1",
        );
        if (found) {
          return found;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("Timed out waiting for nested collab grandchild materialization");
    })();

    expect(grandchildThread.parentThreadId).toBe("thread-child-parent");
    expect(grandchildThread.origin).toEqual({
      kind: "subAgentThreadSpawn",
      parentProviderThreadId: "provider-thread-child-parent",
    });
  });

  // ---------------------------------------------------------------------------
  // RAT-121: Child thread lifecycle hardening — regression tests
  // ---------------------------------------------------------------------------

  it("silently drops runtime events targeting a deleted child and its deleted parent", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await materializeChildThread(harness, {
      threadId: "thread-child-del",
      providerThreadId: "del-child-ptid",
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.makeUnsafe("cmd-delete-parent-for-drop-test"),
        threadId: ThreadId.makeUnsafe("thread-1"),
      }),
    );

    const readModelAfterDelete = await Effect.runPromise(harness.engine.getReadModel());
    const parentAfterDelete = readModelAfterDelete.threads.find(
      (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
    );
    const childAfterDelete = readModelAfterDelete.threads.find(
      (entry) => entry.id === ThreadId.makeUnsafe("thread-child-del"),
    );
    expect(parentAfterDelete?.deletedAt).not.toBeNull();
    expect(childAfterDelete?.deletedAt).not.toBeNull();

    const snapshotBefore = await Effect.runPromise(harness.engine.getReadModel());

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-after-delete"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      providerThreadId: "del-child-ptid",
      turnId: asTurnId("turn-orphan-1"),
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-delta-after-delete"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      providerThreadId: "del-child-ptid",
      turnId: asTurnId("turn-orphan-1"),
      itemId: asItemId("item-orphan-1"),
      payload: { streamKind: "assistant_text", delta: "orphaned" },
    });

    await Effect.runPromise(Effect.sleep("50 millis"));

    const snapshotAfter = await Effect.runPromise(harness.engine.getReadModel());
    const parentAfterEvents = snapshotAfter.threads.find(
      (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
    );
    const childAfterEvents = snapshotAfter.threads.find(
      (entry) => entry.id === ThreadId.makeUnsafe("thread-child-del"),
    );

    expect(parentAfterEvents?.session).toEqual(
      snapshotBefore.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"))?.session,
    );
    expect(childAfterEvents?.session).toEqual(
      snapshotBefore.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-child-del"))
        ?.session,
    );
    expect(childAfterEvents?.messages.length).toBe(
      snapshotBefore.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-child-del"))
        ?.messages.length ?? 0,
    );
  });

  it("updates session providerThreadId when thread.started arrives with a new ID (resume fallback scenario)", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-old-ptid"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          providerThreadId: "old-ptid",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.providerThreadId === "old-ptid",
    );

    harness.emit({
      type: "thread.started",
      eventId: asEventId("evt-thread-started-resume-fallback"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      providerThreadId: "new-ptid",
      payload: {
        providerThreadId: "new-ptid",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (thread) => thread.session?.providerThreadId === "new-ptid",
    );
    expect(thread.session?.providerThreadId).toBe("new-ptid");
  });

  it("drops child turn.completed when turnId does not match child activeTurnId", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await materializeChildThread(harness, {
      threadId: "thread-child-stale-turn",
      providerThreadId: "child-stale-turn-ptid",
    });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-child-session-stale-turn"),
        threadId: ThreadId.makeUnsafe("thread-child-stale-turn"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-child-stale-turn"),
          status: "ready",
          providerName: "codex",
          providerThreadId: "child-stale-turn-ptid",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-child-turn-started-active"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      providerThreadId: "child-stale-turn-ptid",
      turnId: asTurnId("child-turn-active"),
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.activeTurnId === "child-turn-active",
      2000,
      "thread-child-stale-turn",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-child-turn-completed-stale"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      providerThreadId: "child-stale-turn-ptid",
      turnId: asTurnId("child-turn-stale"),
      payload: { state: "completed" },
    });

    await Effect.runPromise(Effect.sleep("50 millis"));
    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const childThread = readModel.threads.find(
      (entry) => entry.id === ThreadId.makeUnsafe("thread-child-stale-turn"),
    );
    expect(childThread?.session?.activeTurnId).toBe("child-turn-active");
    expect(childThread?.session?.status).toBe("running");

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-child-turn-completed-correct"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      providerThreadId: "child-stale-turn-ptid",
      turnId: asTurnId("child-turn-active"),
      payload: { state: "completed" },
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.activeTurnId === null && thread.session?.status === "ready",
      2000,
      "thread-child-stale-turn",
    );
  });

  it("child session.exited only affects child thread session, not parent", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await materializeChildThread(harness, {
      threadId: "thread-child-exited",
      providerThreadId: "child-exited-ptid",
    });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-child-session-exited-setup"),
        threadId: ThreadId.makeUnsafe("thread-child-exited"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-child-exited"),
          status: "running",
          providerName: "codex",
          providerThreadId: "child-exited-ptid",
          runtimeMode: "approval-required",
          activeTurnId: TurnId.makeUnsafe("child-turn-x"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    harness.emit({
      type: "session.exited",
      eventId: asEventId("evt-child-session-exited"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      providerThreadId: "child-exited-ptid",
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "stopped",
      2000,
      "thread-child-exited",
    );

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const child = readModel.threads.find(
      (entry) => entry.id === ThreadId.makeUnsafe("thread-child-exited"),
    );
    const parent = readModel.threads.find(
      (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
    );
    expect(child?.session?.status).toBe("stopped");
    expect(child?.session?.activeTurnId).toBeNull();
    expect(parent?.session?.status).toBe("ready");
  });

  it("child runtime.error only affects child thread, not parent", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await materializeChildThread(harness, {
      threadId: "thread-child-error",
      providerThreadId: "child-error-ptid",
    });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-child-session-error-setup"),
        threadId: ThreadId.makeUnsafe("thread-child-error"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-child-error"),
          status: "running",
          providerName: "codex",
          providerThreadId: "child-error-ptid",
          runtimeMode: "approval-required",
          activeTurnId: TurnId.makeUnsafe("child-turn-err"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    harness.emit({
      type: "runtime.error",
      eventId: asEventId("evt-child-runtime-error"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      providerThreadId: "child-error-ptid",
      turnId: asTurnId("child-turn-err"),
      payload: {
        message: "child process failed",
      },
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "error",
      2000,
      "thread-child-error",
    );

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const child = readModel.threads.find(
      (entry) => entry.id === ThreadId.makeUnsafe("thread-child-error"),
    );
    const parent = readModel.threads.find(
      (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
    );
    expect(child?.session?.status).toBe("error");
    expect(child?.session?.lastError).toBe("child process failed");
    expect(parent?.session?.status).toBe("ready");
    expect(parent?.session?.lastError).toBeNull();
  });

  it("re-materializes a child thread with a previously-deleted providerThreadId", async () => {
    const harness = await createHarness();

    await materializeChildThread(harness, {
      threadId: "thread-child-reuse",
      providerThreadId: "reuse-ptid",
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.makeUnsafe("cmd-delete-parent-for-reuse"),
        threadId: ThreadId.makeUnsafe("thread-1"),
      }),
    );

    const readModelAfterDelete = await Effect.runPromise(harness.engine.getReadModel());
    expect(
      readModelAfterDelete.threads.find(
        (entry) => entry.id === ThreadId.makeUnsafe("thread-child-reuse"),
      )?.deletedAt,
    ).not.toBeNull();

    const newCreatedAt = new Date().toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create-new-parent"),
        threadId: ThreadId.makeUnsafe("thread-2"),
        projectId: asProjectId("project-1"),
        title: "Thread 2",
        model: "gpt-5-codex",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: newCreatedAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-new-parent"),
        threadId: ThreadId.makeUnsafe("thread-2"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-2"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: newCreatedAt,
        },
        createdAt: newCreatedAt,
      }),
    );

    harness.emit({
      type: "thread.started",
      eventId: asEventId("evt-thread-started-reuse-ptid"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-2"),
      providerThreadId: "reuse-ptid",
      payload: {
        providerThreadId: "reuse-ptid",
        source: {
          kind: "subAgentThreadSpawn",
          subagent: {
            thread_spawn: {
              parent_thread_id: "provider-thread-new-parent",
              depth: 1,
            },
          },
        },
      },
    });

    const newChild = await (async () => {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const readModel = await Effect.runPromise(harness.engine.getReadModel());
        const found = readModel.threads.find(
          (thread) =>
            thread.providerThreadId === "reuse-ptid" &&
            thread.deletedAt === null &&
            thread.id !== "thread-child-reuse",
        );
        if (found) {
          return found;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("Timed out waiting for re-materialized child thread");
    })();

    expect(newChild.deletedAt).toBeNull();
    expect(newChild.parentThreadId).toBe("thread-2");
    expect(newChild.providerThreadId).toBe("reuse-ptid");
  });

  it("handles concurrent thread.started events for the same providerThreadId without crashing", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Promise.all([
      Promise.resolve().then(() =>
        harness.emit({
          type: "thread.started",
          eventId: asEventId("evt-thread-started-concurrent-1"),
          provider: "codex",
          createdAt: now,
          threadId: asThreadId("thread-1"),
          providerThreadId: "concurrent-ptid-1",
          payload: {
            providerThreadId: "concurrent-ptid-1",
            source: {
              kind: "subAgentThreadSpawn",
              subagent: {
                thread_spawn: {
                  parent_thread_id: "provider-thread-root-1",
                  depth: 1,
                },
              },
            },
          },
        }),
      ),
      Promise.resolve().then(() =>
        harness.emit({
          type: "thread.started",
          eventId: asEventId("evt-thread-started-concurrent-2"),
          provider: "codex",
          createdAt: now,
          threadId: asThreadId("thread-1"),
          providerThreadId: "concurrent-ptid-1",
          payload: {
            providerThreadId: "concurrent-ptid-1",
            source: {
              kind: "subAgentThreadSpawn",
              subagent: {
                thread_spawn: {
                  parent_thread_id: "provider-thread-root-1",
                  depth: 1,
                },
              },
            },
          },
        }),
      ),
    ]);

    await Effect.runPromise(Effect.sleep("100 millis"));

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const matchingChildren = readModel.threads.filter(
      (thread) => thread.providerThreadId === "concurrent-ptid-1" && thread.deletedAt === null,
    );
    expect(matchingChildren.length).toBe(1);
    const runtimes = await Effect.runPromise(harness.providerSessionRuntimeRepository.list());
    const matchingBindings = runtimes.filter((runtime) => {
      const payload = runtime.resumeCursor;
      return (
        payload !== null &&
        typeof payload === "object" &&
        !Array.isArray(payload) &&
        "threadId" in payload &&
        payload.threadId === "concurrent-ptid-1"
      );
    });
    expect(matchingBindings).toHaveLength(1);
    expect(matchingBindings[0]?.threadId).toBe(matchingChildren[0]?.id);

    // Verify pipeline is still functional by routing a turn event to the child
    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-after-concurrent"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      providerThreadId: "concurrent-ptid-1",
      turnId: asTurnId("turn-concurrent-verify"),
    });

    const child = await waitForThread(
      harness.engine,
      (thread) => thread.session?.activeTurnId === "turn-concurrent-verify",
      2000,
      matchingChildren[0]!.id,
    );
    expect(child.session?.status).toBe("running");
  });
});
