import type { OrchestrationReadModel, ProviderRuntimeEvent } from "@t3tools/contracts";

function liveThreadMatchesProviderThreadId(
  thread: OrchestrationReadModel["threads"][number],
  providerThreadId: string,
): boolean {
  return thread.deletedAt === null && thread.providerThreadId === providerThreadId;
}

export function resolveRuntimeEventTargetThread(
  readModel: OrchestrationReadModel,
  event: ProviderRuntimeEvent,
): OrchestrationReadModel["threads"][number] | undefined {
  const providerThreadId =
    event.providerThreadId ??
    (event.type === "thread.started" ? event.payload.providerThreadId : undefined);
  if (providerThreadId) {
    const matchedThread = readModel.threads.find((thread) =>
      liveThreadMatchesProviderThreadId(thread, providerThreadId),
    );
    if (matchedThread) {
      return matchedThread;
    }
  }

  return readModel.threads.find((thread) => thread.id === event.threadId);
}
