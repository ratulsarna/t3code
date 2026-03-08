import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "../types";
import {
  type SidebarThreadTreeNode,
  buildSidebarProjectThreadTree,
  compareThreadsForSidebar,
  selectVisibleSidebarRootNodes,
} from "./sidebarTree";

function makeThread(overrides: Partial<Thread> & Pick<Thread, "id" | "createdAt">): Thread {
  const { id, createdAt, ...rest } = overrides;
  return {
    id,
    codexThreadId: null,
    parentThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: String(id),
    model: "gpt-5-codex",
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    turnDiffSummaries: [],
    activities: [],
    proposedPlans: [],
    error: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    createdAt,
    ...rest,
  };
}

function collectTreeIds(nodes: readonly SidebarThreadTreeNode[]): string[] {
  const result: string[] = [];
  const visit = (currentNodes: readonly SidebarThreadTreeNode[]) => {
    for (const node of currentNodes) {
      result.push(node.thread.id);
      visit(node.children);
    }
  };
  visit(nodes);
  return result;
}

describe("compareThreadsForSidebar", () => {
  it("sorts newer threads first and breaks ties by descending id", () => {
    const threads = [
      makeThread({
        id: ThreadId.makeUnsafe("thread-1"),
        createdAt: "2026-03-01T00:00:00.000Z",
      }),
      makeThread({
        id: ThreadId.makeUnsafe("thread-3"),
        createdAt: "2026-03-02T00:00:00.000Z",
      }),
      makeThread({
        id: ThreadId.makeUnsafe("thread-2"),
        createdAt: "2026-03-02T00:00:00.000Z",
      }),
    ];

    const sorted = threads.toSorted(compareThreadsForSidebar).map((thread) => thread.id);

    expect(sorted).toEqual(["thread-3", "thread-2", "thread-1"]);
  });
});

describe("buildSidebarProjectThreadTree", () => {
  it("builds nested children under their parent in sidebar order", () => {
    const tree = buildSidebarProjectThreadTree({
      projectId: ProjectId.makeUnsafe("project-1"),
      activeThreadId: null,
      threads: [
        makeThread({
          id: ThreadId.makeUnsafe("root"),
          createdAt: "2026-03-01T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("child-older"),
          parentThreadId: ThreadId.makeUnsafe("root"),
          createdAt: "2026-03-02T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("child-newer"),
          parentThreadId: ThreadId.makeUnsafe("root"),
          createdAt: "2026-03-03T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("grandchild"),
          parentThreadId: ThreadId.makeUnsafe("child-newer"),
          createdAt: "2026-03-04T00:00:00.000Z",
        }),
      ],
    });

    expect(tree.roots.map((node) => node.thread.id)).toEqual(["root"]);
    expect(tree.roots[0]?.children.map((node) => node.thread.id)).toEqual([
      "child-newer",
      "child-older",
    ]);
    expect(tree.roots[0]?.children[0]?.children.map((node) => node.thread.id)).toEqual([
      "grandchild",
    ]);
  });

  it("surfaces orphaned children as roots", () => {
    const tree = buildSidebarProjectThreadTree({
      projectId: ProjectId.makeUnsafe("project-1"),
      activeThreadId: null,
      threads: [
        makeThread({
          id: ThreadId.makeUnsafe("orphan"),
          parentThreadId: ThreadId.makeUnsafe("missing-parent"),
          createdAt: "2026-03-02T00:00:00.000Z",
        }),
      ],
    });

    expect(tree.roots.map((node) => node.thread.id)).toEqual(["orphan"]);
  });

  it("surfaces cross-project parent references as roots", () => {
    const tree = buildSidebarProjectThreadTree({
      projectId: ProjectId.makeUnsafe("project-1"),
      activeThreadId: null,
      threads: [
        makeThread({
          id: ThreadId.makeUnsafe("foreign-parent"),
          projectId: ProjectId.makeUnsafe("project-2"),
          createdAt: "2026-03-03T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("child"),
          parentThreadId: ThreadId.makeUnsafe("foreign-parent"),
          createdAt: "2026-03-02T00:00:00.000Z",
        }),
      ],
    });

    expect(tree.roots.map((node) => node.thread.id)).toEqual(["child"]);
  });

  it("surfaces self-parenting threads as roots", () => {
    const tree = buildSidebarProjectThreadTree({
      projectId: ProjectId.makeUnsafe("project-1"),
      activeThreadId: null,
      threads: [
        makeThread({
          id: ThreadId.makeUnsafe("self"),
          parentThreadId: ThreadId.makeUnsafe("self"),
          createdAt: "2026-03-02T00:00:00.000Z",
        }),
      ],
    });

    expect(tree.roots.map((node) => node.thread.id)).toEqual(["self"]);
  });

  it("breaks cycles safely and renders each thread once", () => {
    const tree = buildSidebarProjectThreadTree({
      projectId: ProjectId.makeUnsafe("project-1"),
      activeThreadId: ThreadId.makeUnsafe("b"),
      threads: [
        makeThread({
          id: ThreadId.makeUnsafe("a"),
          parentThreadId: ThreadId.makeUnsafe("c"),
          createdAt: "2026-03-01T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("b"),
          parentThreadId: ThreadId.makeUnsafe("a"),
          createdAt: "2026-03-02T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("c"),
          parentThreadId: ThreadId.makeUnsafe("b"),
          createdAt: "2026-03-03T00:00:00.000Z",
        }),
      ],
    });

    expect(tree.roots.map((node) => node.thread.id)).toEqual(["c"]);
    expect(collectTreeIds(tree.roots)).toEqual(["c", "a", "b"]);
    expect([...tree.activeAncestorThreadIds]).toEqual(["a", "c"]);
    expect(tree.activeRootThreadId).toBe("c");
  });

  it("returns active ancestors for a nested active thread", () => {
    const tree = buildSidebarProjectThreadTree({
      projectId: ProjectId.makeUnsafe("project-1"),
      activeThreadId: ThreadId.makeUnsafe("grandchild"),
      threads: [
        makeThread({
          id: ThreadId.makeUnsafe("root"),
          createdAt: "2026-03-01T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("child"),
          parentThreadId: ThreadId.makeUnsafe("root"),
          createdAt: "2026-03-02T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("grandchild"),
          parentThreadId: ThreadId.makeUnsafe("child"),
          createdAt: "2026-03-03T00:00:00.000Z",
        }),
      ],
    });

    expect([...tree.activeAncestorThreadIds]).toEqual(["child", "root"]);
    expect(tree.activeRootThreadId).toBe("root");
  });
});

describe("selectVisibleSidebarRootNodes", () => {
  it("applies the preview limit to root threads", () => {
    const tree = buildSidebarProjectThreadTree({
      projectId: ProjectId.makeUnsafe("project-1"),
      activeThreadId: null,
      threads: [
        makeThread({
          id: ThreadId.makeUnsafe("root-1"),
          createdAt: "2026-03-04T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("root-2"),
          createdAt: "2026-03-03T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("root-3"),
          createdAt: "2026-03-02T00:00:00.000Z",
        }),
      ],
    });

    const visible = selectVisibleSidebarRootNodes({
      roots: tree.roots,
      previewLimit: 2,
      showAll: false,
      activeRootThreadId: tree.activeRootThreadId,
    });

    expect(visible.roots.map((node) => node.thread.id)).toEqual(["root-1", "root-2"]);
    expect(visible.hiddenRootCount).toBe(1);
  });

  it("forces the active root into view when it would otherwise be clipped", () => {
    const tree = buildSidebarProjectThreadTree({
      projectId: ProjectId.makeUnsafe("project-1"),
      activeThreadId: ThreadId.makeUnsafe("child-3"),
      threads: [
        makeThread({
          id: ThreadId.makeUnsafe("root-1"),
          createdAt: "2026-03-05T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("root-2"),
          createdAt: "2026-03-04T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("root-3"),
          createdAt: "2026-03-03T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("child-3"),
          parentThreadId: ThreadId.makeUnsafe("root-3"),
          createdAt: "2026-03-02T00:00:00.000Z",
        }),
      ],
    });

    const visible = selectVisibleSidebarRootNodes({
      roots: tree.roots,
      previewLimit: 2,
      showAll: false,
      activeRootThreadId: tree.activeRootThreadId,
    });

    expect(visible.roots.map((node) => node.thread.id)).toEqual(["root-1", "root-2", "root-3"]);
    expect(visible.hiddenRootCount).toBe(0);
  });
});
