import type { ProjectId, ThreadId } from "@t3tools/contracts";

import { type Thread } from "../types";

export interface SidebarThreadTreeNode {
  thread: Thread;
  children: SidebarThreadTreeNode[];
}

export interface SidebarProjectThreadTree {
  roots: SidebarThreadTreeNode[];
  activeAncestorThreadIds: ReadonlySet<ThreadId>;
  activeRootThreadId: ThreadId | null;
}

export interface SelectVisibleSidebarRootNodesInput {
  roots: readonly SidebarThreadTreeNode[];
  previewLimit: number;
  showAll: boolean;
  activeRootThreadId: ThreadId | null;
}

export interface SidebarVisibleRootSelection {
  roots: SidebarThreadTreeNode[];
  hiddenRootCount: number;
}

export function compareThreadsForSidebar(a: Thread, b: Thread): number {
  const byDate = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  if (byDate !== 0) return byDate;
  return b.id.localeCompare(a.id);
}

function isValidParentThread(options: {
  thread: Thread;
  parent: Thread | undefined;
  projectId: ProjectId;
}): boolean {
  if (!options.parent) {
    return false;
  }

  if (options.parent.id === options.thread.id) {
    return false;
  }

  return options.parent.projectId === options.projectId;
}

export function buildSidebarProjectThreadTree(input: {
  threads: readonly Thread[];
  projectId: ProjectId;
  activeThreadId: ThreadId | null;
}): SidebarProjectThreadTree {
  const projectThreads = input.threads
    .filter((thread) => thread.projectId === input.projectId)
    .toSorted(compareThreadsForSidebar);
  const threadById = new Map(projectThreads.map((thread) => [thread.id, thread] as const));
  const childThreadIdsByParentId = new Map<ThreadId, ThreadId[]>();

  for (const thread of projectThreads) {
    const parentThreadId = thread.parentThreadId ?? null;
    if (parentThreadId === null) {
      continue;
    }
    const parentThread = threadById.get(parentThreadId);
    if (!isValidParentThread({ thread, parent: parentThread, projectId: input.projectId })) {
      continue;
    }
    const existingChildren = childThreadIdsByParentId.get(parentThreadId);
    if (existingChildren) {
      existingChildren.push(thread.id);
    } else {
      childThreadIdsByParentId.set(parentThreadId, [thread.id]);
    }
  }

  for (const childThreadIds of childThreadIdsByParentId.values()) {
    childThreadIds.sort((leftId, rightId) => {
      const leftThread = threadById.get(leftId);
      const rightThread = threadById.get(rightId);
      if (!leftThread || !rightThread) {
        return 0;
      }
      return compareThreadsForSidebar(leftThread, rightThread);
    });
  }

  const roots: SidebarThreadTreeNode[] = [];
  const placedThreadIds = new Set<ThreadId>();
  const attachedParentThreadIdByThreadId = new Map<ThreadId, ThreadId>();
  const rootThreadIdByThreadId = new Map<ThreadId, ThreadId>();

  const buildNode = (threadId: ThreadId, rootThreadId: ThreadId, path: ReadonlySet<ThreadId>) => {
    const thread = threadById.get(threadId);
    if (!thread || placedThreadIds.has(threadId)) {
      return null;
    }

    placedThreadIds.add(threadId);
    rootThreadIdByThreadId.set(threadId, rootThreadId);

    const nextPath = new Set(path);
    nextPath.add(threadId);

    const children: SidebarThreadTreeNode[] = [];
    for (const childThreadId of childThreadIdsByParentId.get(threadId) ?? []) {
      if (placedThreadIds.has(childThreadId) || nextPath.has(childThreadId)) {
        continue;
      }
      const childNode = buildNode(childThreadId, rootThreadId, nextPath);
      if (!childNode) {
        continue;
      }
      attachedParentThreadIdByThreadId.set(childThreadId, threadId);
      children.push(childNode);
    }

    return {
      thread,
      children,
    } satisfies SidebarThreadTreeNode;
  };

  const naturalRoots = projectThreads.filter((thread) => {
    const parentThreadId = thread.parentThreadId ?? null;
    if (parentThreadId === null) {
      return true;
    }
    const parentThread = threadById.get(parentThreadId);
    return !isValidParentThread({ thread, parent: parentThread, projectId: input.projectId });
  });

  for (const rootThread of naturalRoots) {
    const rootNode = buildNode(rootThread.id, rootThread.id, new Set());
    if (rootNode) {
      roots.push(rootNode);
    }
  }

  for (const thread of projectThreads) {
    if (placedThreadIds.has(thread.id)) {
      continue;
    }
    const fallbackRoot = buildNode(thread.id, thread.id, new Set());
    if (fallbackRoot) {
      roots.push(fallbackRoot);
    }
  }

  const activeRootThreadId =
    input.activeThreadId && threadById.has(input.activeThreadId)
      ? (rootThreadIdByThreadId.get(input.activeThreadId) ?? input.activeThreadId)
      : null;
  const activeAncestorThreadIds = new Set<ThreadId>();

  if (input.activeThreadId && threadById.has(input.activeThreadId)) {
    let currentThreadId = attachedParentThreadIdByThreadId.get(input.activeThreadId) ?? null;
    while (currentThreadId) {
      if (activeAncestorThreadIds.has(currentThreadId)) {
        break;
      }
      activeAncestorThreadIds.add(currentThreadId);
      currentThreadId = attachedParentThreadIdByThreadId.get(currentThreadId) ?? null;
    }
  }

  return {
    roots,
    activeAncestorThreadIds,
    activeRootThreadId,
  };
}

export function selectVisibleSidebarRootNodes(
  input: SelectVisibleSidebarRootNodesInput,
): SidebarVisibleRootSelection {
  const previewLimit = Math.max(0, input.previewLimit);
  if (input.showAll || input.roots.length <= previewLimit) {
    return {
      roots: [...input.roots],
      hiddenRootCount: 0,
    };
  }

  const visibleRootIndexes = new Set<number>();
  for (let index = 0; index < previewLimit; index += 1) {
    if (index >= input.roots.length) {
      break;
    }
    visibleRootIndexes.add(index);
  }

  if (input.activeRootThreadId !== null) {
    const activeRootIndex = input.roots.findIndex(
      (root) => root.thread.id === input.activeRootThreadId,
    );
    if (activeRootIndex >= 0) {
      visibleRootIndexes.add(activeRootIndex);
    }
  }

  const visibleRoots = input.roots.filter((_, index) => visibleRootIndexes.has(index));
  return {
    roots: visibleRoots,
    hiddenRootCount: input.roots.length - visibleRoots.length,
  };
}
