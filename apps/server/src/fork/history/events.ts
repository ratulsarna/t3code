import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  EventId,
  MessageId,
  ProviderDriverKind,
  RuntimeRequestId,
  TurnItemId,
  defaultInstanceIdForDriver,
  type ChatAttachment,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { bbProjectId, bbThreadId } from "./ids.ts";
import type { HistoryRecord, Row, WorkRow } from "./records.ts";

const at = DateTime.makeUnsafe;
const optionalAt = (value: number | null) => (value === null ? null : at(value));

function selection(provider: string, sourceModel: string | null) {
  const driver = ProviderDriverKind.make(
    { codex: "codex", "claude-code": "claudeAgent", pi: "pi" }[provider] ?? "codex",
  );
  return {
    instanceId: defaultInstanceIdForDriver(driver),
    model: sourceModel?.trim() || DEFAULT_MODEL_BY_PROVIDER[driver] || DEFAULT_MODEL,
  };
}

function activityStatus(row: WorkRow): OrchestrationV2TurnItem["status"] {
  if (row.status === "error") return "failed";
  if (row.status === "completed") return "completed";
  return "interrupted";
}

function rowEvents(
  threadId: ThreadId,
  ordinal: number,
  row: Row,
  attachments: readonly ChatAttachment[],
  missing: readonly string[],
): readonly OrchestrationV2DomainEvent[] {
  const createdAt = at(row.createdAt);
  const startedAt = at(row.startedAt);
  const completedAt = at((row.kind !== "conversation" && row.completedAt) || row.createdAt);
  const id = TurnItemId.make(`${threadId}:item:${ordinal}`);
  const base = {
    id,
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    startedAt,
    completedAt,
    updatedAt: completedAt,
    status: "completed" as const,
    title: null,
  };
  const turn = (payload: OrchestrationV2TurnItem): OrchestrationV2DomainEvent => ({
    id: EventId.make(id),
    threadId,
    occurredAt: completedAt,
    type: "turn-item.updated",
    payload,
  });
  if (row.kind === "conversation") {
    if (row.nested || (row.role === "user" && row.turnRequest?.status !== "accepted")) {
      const title = row.nested
        ? `Delegated ${row.role} message`
        : `bb input · ${row.turnRequest?.status ?? "unaccepted"}`;
      return [
        turn({
          ...base,
          type: "dynamic_tool",
          title,
          toolName: "bb history",
          input: {},
          output: row.text,
        }),
      ];
    }
    const messageId = MessageId.make(`${threadId}:message:${ordinal}`);
    const sender = row.senderThreadId ? { senderThreadId: bbThreadId(row.senderThreadId) } : {};
    const message: OrchestrationV2ConversationMessage = {
      ...sender,
      createdBy: row.role === "user" ? "user" : "agent",
      creationSource: "server",
      id: messageId,
      threadId,
      runId: null,
      nodeId: null,
      role: row.role,
      text: row.text,
      attachments,
      streaming: false,
      createdAt,
      updatedAt: completedAt,
    };
    const item =
      row.role === "user"
        ? turn({
            ...base,
            ...sender,
            type: "user_message",
            createdBy: "user",
            creationSource: "server",
            inputIntent: "turn_start",
            messageId,
            text: row.text,
            attachments,
          })
        : turn({
            ...base,
            type: "assistant_message",
            messageId,
            text: row.text,
            attachments,
            streaming: false,
          });
    return [
      {
        id: EventId.make(messageId),
        threadId,
        occurredAt: createdAt,
        type: "message.updated",
        payload: message,
      },
      item,
      ...(missing.length === 0
        ? []
        : [
            {
              id: EventId.make(`${id}:missing`),
              threadId,
              occurredAt: completedAt,
              type: "turn-item.updated" as const,
              payload: {
                ...base,
                id: TurnItemId.make(`${id}:missing`),
                ordinal: ordinal + 1,
                type: "system_notice" as const,
                message: `bb attachment unavailable: ${missing.join(", ")}`,
                level: "info" as const,
              },
            },
          ]),
    ];
  }
  if (row.kind === "system") {
    if (row.operationKind === "reasoning") {
      return [
        turn({ ...base, type: "reasoning", text: row.detail ?? row.title, streaming: false }),
      ];
    }
    return [
      turn({
        ...base,
        type: "system_notice",
        title:
          row.operationKind === "context-clear" && row.status === "completed"
            ? "bb context cleared"
            : row.title.trim() || null,
        message: row.detail ? `${row.title}\n${row.detail}` : row.title,
        level: row.systemKind === "error" ? "error" : "info",
      }),
    ];
  }
  return [turn({ ...base, status: activityStatus(row), ...workPayload(row) })];
}

function workPayload(row: WorkRow) {
  switch (row.workKind) {
    case "command":
      return {
        type: "command_execution" as const,
        input: row.command,
        output: row.output,
        ...(Number.isInteger(row.exitCode) && row.exitCode !== null
          ? { exitCode: row.exitCode }
          : {}),
      };
    case "tool":
      return {
        type: "dynamic_tool" as const,
        title: row.toolName.trim() || "bb tool",
        toolName: "bb history",
        input: row.toolArgs,
        output: row.output,
      };
    case "file-change":
      return {
        type: "file_change" as const,
        fileName: row.change.path.trim() || "(unknown file)",
        additions: row.change.diffStats.added,
        deletions: row.change.diffStats.removed,
        ...(row.change.diff === null ? {} : { diffStr: row.change.diff }),
      };
    case "web-search":
      return { type: "web_search" as const, patterns: row.queries };
    case "question": {
      const requestId = RuntimeRequestId.make(`bb:${row.interactionId}`);
      const questions = row.questions.map((question) => ({
        id: question.id.trim(),
        header: question.shortLabel?.trim() || "Question",
        question: question.prompt.trim(),
        options: (question.options ?? []).map((option) => ({
          label: option.label.trim(),
          description: option.description?.trim() || option.label.trim(),
          value: option.value,
        })),
        multiSelect: question.multiSelect,
        allowCustomAnswer: question.allowFreeText,
        required: question.required,
      }));
      const answers = Object.fromEntries(
        Object.entries(row.answers ?? {}).map(([id, answer]) => {
          const options = questions.find((question) => question.id === id)?.options ?? [];
          return [
            id,
            [
              ...answer.selected.map(
                (selected) =>
                  options.find((option) => option.value === selected)?.label ?? selected,
              ),
              ...(answer.freeText ? [answer.freeText] : []),
            ],
          ];
        }),
      );
      return {
        type: "user_input_request" as const,
        title: `bb question · ${row.lifecycle}`,
        requestId,
        questions,
        questionAnswer: {
          requestId,
          questionTextById: Object.fromEntries(
            questions.map((question) => [question.id, question.question]),
          ),
          answers,
          attachmentsByQuestionId: {},
        },
      };
    }
    case "approval":
      return {
        type: "approval_request" as const,
        title: `bb ${row.approvalKind} approval · ${row.lifecycle}`,
        requestId: RuntimeRequestId.make(`bb:${row.interactionId}`),
        requestKind:
          row.approvalKind === "file-edit" ? ("file-change" as const) : ("permission" as const),
        ...(row.statusReason ? { reason: row.statusReason } : {}),
        ...(row.target.toolName ? { prompt: row.target.toolName } : {}),
      };
    default:
      return {
        type: "dynamic_tool" as const,
        title: `bb ${row.workKind}`,
        toolName: "bb history",
        input: {},
        output: JSON.stringify(row, null, 2),
      };
  }
}

export function eventsForThread(
  record: HistoryRecord,
  attachmentMap: ReadonlyMap<string, ChatAttachment>,
  unavailable: ReadonlyMap<string, string>,
  followedChildren: readonly string[],
): OrchestrationV2DomainEvent[] {
  const { thread, items, links } = record;
  const id = bbThreadId(thread.id);
  const modelSelection = selection(thread.provider_id, thread.model);
  const createdAt = at(thread.created_at);
  const updatedAt = at(thread.updated_at);
  const payload: OrchestrationV2AppThread = {
    id,
    createdBy: "system",
    creationSource: "server",
    projectId: bbProjectId(thread.project_id),
    title: thread.title?.trim() || thread.title_fallback?.trim() || "Untitled bb thread",
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    historyOrigin: "bb_import",
    activeProviderThreadId: null,
    forkedFrom: null,
    lineage: {
      parentThreadId: links.forkParent ? bbThreadId(links.forkParent) : null,
      relationshipToParent: links.forkParent ? "fork" : null,
      rootThreadId: bbThreadId(links.forkRoot),
    },
    createdAt,
    updatedAt,
    archivedAt: optionalAt(thread.archived_at),
    settledOverride: "settled",
    settledAt: updatedAt,
    pinnedAt: optionalAt(thread.pinned_at),
    pinOrderKey: thread.pin_sort_key,
    lastVisitedAt: optionalAt(thread.last_read_at),
    deletedAt: null,
  };
  const metadataId = TurnItemId.make(`${id}:provenance`);
  const base = {
    threadId: id,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    startedAt: createdAt,
    completedAt: createdAt,
    updatedAt: createdAt,
    status: "completed" as const,
  };
  const events: OrchestrationV2DomainEvent[] = [
    {
      id: EventId.make(`${id}:created`),
      threadId: id,
      type: "thread.created",
      occurredAt: createdAt,
      payload,
    },
    {
      id: EventId.make(metadataId),
      threadId: id,
      type: "turn-item.updated",
      occurredAt: createdAt,
      payload: {
        ...base,
        id: metadataId,
        ordinal: 0,
        type: "dynamic_tool",
        title: "Imported from bb",
        toolName: "bb history",
        input: {},
        output: JSON.stringify(
          { ...thread, children: links.children, unavailable: Object.fromEntries(unavailable) },
          null,
          2,
        ),
      },
    },
  ];
  for (const [index, item] of items.entries()) {
    const paths =
      item.kind === "conversation" && item.attachments
        ? [...new Set([...item.attachments.localImagePaths, ...item.attachments.localFilePaths])]
        : [];
    const attachments = [];
    const missing = [];
    for (const path of paths) {
      const attachment = attachmentMap.get(path);
      if (attachment) {
        attachments.push(attachment);
      } else missing.push(path);
    }
    if (item.kind === "conversation" && item.attachments) {
      missing.push(...item.attachments.imageUrls);
    }
    events.push(...rowEvents(id, (index + 1) * 2, item, attachments, missing));
  }
  for (const [index, child] of followedChildren.entries()) {
    const childItemId = TurnItemId.make(`${id}:child:${child}`);
    events.push({
      id: EventId.make(childItemId),
      threadId: id,
      type: "turn-item.updated",
      occurredAt: updatedAt,
      payload: {
        ...base,
        id: childItemId,
        ordinal: (items.length + index + 1) * 2,
        type: "thread_created",
        title: "bb child chat",
        targetThreadId: bbThreadId(child),
        targetRunId: null,
        targetProviderInstanceId: modelSelection.instanceId,
        targetModel: modelSelection.model,
      },
    });
  }
  return events;
}
