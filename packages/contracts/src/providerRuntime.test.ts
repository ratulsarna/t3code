import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { ProviderRuntimeEvent } from "./providerRuntime";

const decodeRuntimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);

describe("ProviderRuntimeEvent", () => {
  it("decodes turn.plan.updated for plan rendering", () => {
    const parsed = decodeRuntimeEvent({
      type: "turn.plan.updated",
      eventId: "event-1",
      provider: "codex",
      sessionId: "runtime-session-1",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        explanation: "Implement schema updates",
        plan: [
          { step: "Define event union", status: "completed" },
          { step: "Wire adapter mapping", status: "inProgress" },
        ],
      },
    });

    expect(parsed.type).toBe("turn.plan.updated");
    if (parsed.type !== "turn.plan.updated") {
      throw new Error("expected turn.plan.updated");
    }
    expect(parsed.payload.plan).toHaveLength(2);
    expect(parsed.payload.plan[1]?.status).toBe("inProgress");
  });

  it("decodes proposed-plan completion events", () => {
    const parsed = decodeRuntimeEvent({
      type: "turn.proposed.completed",
      eventId: "event-proposed-plan-1",
      provider: "codex",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        planMarkdown: "# Ship it",
      },
    });

    expect(parsed.type).toBe("turn.proposed.completed");
    if (parsed.type !== "turn.proposed.completed") {
      throw new Error("expected turn.proposed.completed");
    }
    expect(parsed.payload.planMarkdown).toBe("# Ship it");
  });

  it("decodes user-input.requested with structured questions", () => {
    const parsed = decodeRuntimeEvent({
      type: "user-input.requested",
      eventId: "event-2",
      provider: "codex",
      sessionId: "runtime-session-2",
      createdAt: "2026-02-28T00:00:01.000Z",
      threadId: "thread-2",
      requestId: "request-1",
      payload: {
        questions: [
          {
            id: "sandbox_mode",
            header: "Sandbox",
            question: "Which mode should be used?",
            options: [
              {
                label: "workspace-write",
                description: "Allow edits in workspace only",
              },
              {
                label: "danger-full-access",
                description: "Allow unrestricted access",
              },
            ],
          },
        ],
      },
    });

    expect(parsed.type).toBe("user-input.requested");
    if (parsed.type !== "user-input.requested") {
      throw new Error("expected user-input.requested");
    }
    expect(parsed.payload.questions[0]?.id).toBe("sandbox_mode");
    expect(parsed.payload.questions[0]?.options).toHaveLength(2);
  });

  it("decodes user-input.resolved with answer map", () => {
    const parsed = decodeRuntimeEvent({
      type: "user-input.resolved",
      eventId: "event-3",
      provider: "codex",
      sessionId: "runtime-session-2",
      createdAt: "2026-02-28T00:00:02.000Z",
      threadId: "thread-2",
      requestId: "request-1",
      payload: {
        answers: {
          sandbox_mode: "workspace-write",
        },
      },
    });

    expect(parsed.type).toBe("user-input.resolved");
    if (parsed.type !== "user-input.resolved") {
      throw new Error("expected user-input.resolved");
    }
    expect(parsed.payload.answers.sandbox_mode).toBe("workspace-write");
  });

  it("decodes thread.started with spawned subagent metadata", () => {
    const parsed = decodeRuntimeEvent({
      type: "thread.started",
      eventId: "event-thread-started-1",
      provider: "codex",
      createdAt: "2026-02-28T00:00:04.000Z",
      threadId: "thread-1",
      payload: {
        providerThreadId: "provider-thread-1",
        name: null,
        preview: "",
        status: {
          type: "active",
          activeFlags: [],
        },
        source: {
          kind: "subAgentThreadSpawn",
          parentProviderThreadId: "provider-parent-1",
          depth: 1,
          agentNickname: "Atlas",
          agentRole: "explorer",
        },
      },
    });

    expect(parsed.type).toBe("thread.started");
    if (parsed.type !== "thread.started") {
      throw new Error("expected thread.started");
    }
    expect(parsed.payload.providerThreadId).toBe("provider-thread-1");
    expect(parsed.payload.name).toBeNull();
    expect(parsed.payload.preview).toBe("");
    expect(parsed.payload.source).toEqual({
      kind: "subAgentThreadSpawn",
      parentProviderThreadId: "provider-parent-1",
      depth: 1,
      agentNickname: "Atlas",
      agentRole: "explorer",
    });
  });

  it("decodes thread.started with minimal legacy payload", () => {
    const parsed = decodeRuntimeEvent({
      type: "thread.started",
      eventId: "event-thread-started-2",
      provider: "codex",
      createdAt: "2026-02-28T00:00:05.000Z",
      threadId: "thread-1",
      payload: {
        providerThreadId: "provider-thread-2",
      },
    });

    expect(parsed.type).toBe("thread.started");
    if (parsed.type !== "thread.started") {
      throw new Error("expected thread.started");
    }
    expect(parsed.payload).toEqual({
      providerThreadId: "provider-thread-2",
    });
  });

  it("decodes thread.started with non-thread-spawn source variants", () => {
    const parsed = decodeRuntimeEvent({
      type: "thread.started",
      eventId: "event-thread-started-3",
      provider: "codex",
      createdAt: "2026-02-28T00:00:06.000Z",
      threadId: "thread-1",
      payload: {
        providerThreadId: "provider-thread-3",
        source: {
          kind: "subAgentOther",
          agentNickname: null,
          agentRole: null,
          otherKind: "memory_consolidation",
        },
      },
    });

    expect(parsed.type).toBe("thread.started");
    if (parsed.type !== "thread.started") {
      throw new Error("expected thread.started");
    }
    expect(parsed.payload.source).toEqual({
      kind: "subAgentOther",
      agentNickname: null,
      agentRole: null,
      otherKind: "memory_consolidation",
    });
  });

  it("rejects legacy message.delta type", () => {
    expect(() =>
      decodeRuntimeEvent({
        type: "message.delta",
        eventId: "event-4",
        provider: "codex",
        sessionId: "runtime-session-3",
        createdAt: "2026-02-28T00:00:03.000Z",
        payload: { delta: "legacy" },
      }),
    ).toThrow();
  });

  it("rejects empty branded canonical ids", () => {
    expect(() =>
      decodeRuntimeEvent({
        type: "runtime.error",
        eventId: "event-5",
        provider: "codex",
        sessionId: "runtime-session-3",
        createdAt: "2026-02-28T00:00:03.000Z",
        threadId: "   ",
        payload: { message: "boom" },
      }),
    ).toThrow();
  });

  it("rejects thread.started with negative source depth", () => {
    expect(() =>
      decodeRuntimeEvent({
        type: "thread.started",
        eventId: "event-thread-started-4",
        provider: "codex",
        createdAt: "2026-02-28T00:00:07.000Z",
        threadId: "thread-1",
        payload: {
          providerThreadId: "provider-thread-4",
          source: {
            kind: "subAgentThreadSpawn",
            depth: -1,
          },
        },
      }),
    ).toThrow();
  });
});
