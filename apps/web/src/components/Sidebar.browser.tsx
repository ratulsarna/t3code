// Production CSS is part of the behavior under test because the sidebar layout depends on it.
import "../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  useParams,
} from "@tanstack/react-router";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { SidebarInset, Sidebar as SidebarShell, SidebarProvider } from "./ui/sidebar";
import ThreadSidebar from "./Sidebar";
import { useStore } from "../store";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Project, type Thread } from "../types";
import { ProjectId, ThreadId, type NativeApi, type ServerConfig } from "@t3tools/contracts";
import { useComposerDraftStore } from "../composerDraftStore";
import { useTerminalStateStore } from "../terminalStateStore";

const PROJECT_ID = ProjectId.makeUnsafe("project-1");

function createServerConfig(): ServerConfig {
  return {
    cwd: "/repo/project",
    keybindingsConfigPath: "/repo/project/.t3code-keybindings.json",
    keybindings: [],
    issues: [],
    providers: [
      {
        provider: "codex",
        status: "ready",
        available: true,
        authStatus: "authenticated",
        checkedAt: "2026-03-08T00:00:00.000Z",
      },
    ],
    availableEditors: [],
  };
}

function makeProject(): Project {
  return {
    id: PROJECT_ID,
    name: "Project",
    cwd: "/repo/project",
    model: "gpt-5-codex",
    expanded: true,
    scripts: [],
  };
}

function makeThread(
  id: string,
  overrides: Partial<Thread> = {},
): Thread {
  return {
    id: ThreadId.makeUnsafe(id),
    codexThreadId: null,
    parentThreadId: null,
    projectId: PROJECT_ID,
    title: id,
    model: "gpt-5-codex",
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    turnDiffSummaries: [],
    activities: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-03-08T00:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  };
}

function createNativeApiStub(): NativeApi {
  return {
    server: {
      getConfig: async () => createServerConfig(),
    },
    orchestration: {
      dispatchCommand: async () => ({ sequence: 0 }),
    },
    terminal: {
      close: async () => undefined,
      onEvent: () => () => undefined,
    },
    shell: {
      openExternal: async () => true,
    },
    dialogs: {
      confirm: async () => false,
    },
    contextMenu: {
      show: async () => null,
    },
  } as unknown as NativeApi;
}

const rootRoute = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  component: TestLayout,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => <div data-testid="active-thread-view">No thread selected</div>,
});

const threadRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$threadId",
  component: ActiveThreadPane,
});

const routeTree = rootRoute.addChildren([indexRoute, threadRoute]);

function TestLayout() {
  return (
    <SidebarProvider defaultOpen>
      <SidebarShell
        side="left"
        collapsible="offcanvas"
        className="border-r border-border bg-card text-foreground"
      >
        <ThreadSidebar />
      </SidebarShell>
      <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  );
}

function ActiveThreadPane() {
  const threadId = useParams({
    strict: false,
    select: (params) => params.threadId ?? null,
  });
  const activeThread = useStore((store) =>
    threadId ? store.threads.find((thread) => thread.id === ThreadId.makeUnsafe(threadId)) ?? null : null,
  );
  return <div data-testid="active-thread-view">{activeThread?.title ?? "Missing thread"}</div>;
}

function createTestRouter(initialEntries: string[]) {
  const queryClient = new QueryClient();
  return createRouter({
    routeTree,
    history: createMemoryHistory({
      initialEntries,
    }),
    context: {
      queryClient,
    },
    Wrap: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
}

async function renderSidebarApp(options: {
  initialEntries: string[];
  threads: Thread[];
}) {
  useStore.setState({
    projects: [makeProject()],
    threads: options.threads,
    threadsHydrated: true,
  });

  const router = createTestRouter(options.initialEntries);
  const screen = await render(<RouterProvider router={router} />);
  await vi.waitFor(() => {
    expect(document.querySelector('[data-testid="active-thread-view"]')).toBeTruthy();
  });

  return {
    screen,
    router,
  };
}

async function waitForThreadRow(threadId: string): Promise<HTMLElement> {
  let element: HTMLElement | null = null;
  await vi.waitFor(() => {
    element = document.querySelector<HTMLElement>(`[data-sidebar-thread-id="${threadId}"]`);
    expect(element).toBeTruthy();
  });
  if (!element) {
    throw new Error(`Unable to find sidebar thread row for ${threadId}.`);
  }
  return element;
}

async function waitForThreadToggle(threadId: string): Promise<HTMLButtonElement> {
  let element: HTMLButtonElement | null = null;
  await vi.waitFor(() => {
    element = document.querySelector<HTMLButtonElement>(
      `[data-sidebar-thread-toggle="${threadId}"]`,
    );
    expect(element).toBeTruthy();
  });
  if (!element) {
    throw new Error(`Unable to find sidebar toggle for ${threadId}.`);
  }
  return element;
}

describe("Sidebar subagent tree", () => {
  beforeEach(async () => {
    await page.viewport(1280, 900);
    window.nativeApi = createNativeApiStub();
    delete window.desktopBridge;
    localStorage.clear();
    document.body.innerHTML = "";
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
    });
    useStore.setState({
      projects: [],
      threads: [],
      threadsHydrated: false,
    });
    useTerminalStateStore.setState({
      terminalStateByThreadId: {},
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
    delete window.nativeApi;
  });

  it("auto-expands the active ancestor chain and keeps the active root visible", async () => {
    await renderSidebarApp({
      initialEntries: ["/child-7"],
      threads: [
        makeThread("root-1", { createdAt: "2026-03-08T09:00:00.000Z" }),
        makeThread("root-2", { createdAt: "2026-03-08T08:00:00.000Z" }),
        makeThread("root-3", { createdAt: "2026-03-08T07:00:00.000Z" }),
        makeThread("root-4", { createdAt: "2026-03-08T06:00:00.000Z" }),
        makeThread("root-5", { createdAt: "2026-03-08T05:00:00.000Z" }),
        makeThread("root-6", { createdAt: "2026-03-08T04:00:00.000Z" }),
        makeThread("root-7", { createdAt: "2026-03-08T03:00:00.000Z" }),
        makeThread("child-7", {
          title: "Child Seven",
          parentThreadId: ThreadId.makeUnsafe("root-7"),
          createdAt: "2026-03-08T02:00:00.000Z",
        }),
      ],
    });

    expect(await waitForThreadRow("root-7")).toBeTruthy();
    expect(await waitForThreadRow("child-7")).toBeTruthy();
    expect((await waitForThreadToggle("root-7")).getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector('[data-testid="active-thread-view"]')?.textContent).toBe(
      "Child Seven",
    );
  });

  it("keeps inactive branches collapsed until the user expands them", async () => {
    await renderSidebarApp({
      initialEntries: ["/root-other"],
      threads: [
        makeThread("root-parent", { title: "Root Parent", createdAt: "2026-03-08T05:00:00.000Z" }),
        makeThread("child-hidden", {
          title: "Child Hidden",
          parentThreadId: ThreadId.makeUnsafe("root-parent"),
          createdAt: "2026-03-08T04:00:00.000Z",
        }),
        makeThread("root-other", { title: "Root Other", createdAt: "2026-03-08T06:00:00.000Z" }),
      ],
    });

    expect(await waitForThreadRow("root-parent")).toBeTruthy();
    expect(document.querySelector('[data-sidebar-thread-id="child-hidden"]')).toBeNull();

    const toggle = await waitForThreadToggle("root-parent");
    await toggle.click();
    expect(await waitForThreadRow("child-hidden")).toBeTruthy();

    await toggle.click();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-sidebar-thread-id="child-hidden"]')).toBeNull();
    });
  });

  it("expands a branch from the keyboard without navigating when the toggle is focused", async () => {
    const { router } = await renderSidebarApp({
      initialEntries: ["/root-other"],
      threads: [
        makeThread("root-parent", { title: "Root Parent", createdAt: "2026-03-08T05:00:00.000Z" }),
        makeThread("child-hidden", {
          title: "Child Hidden",
          parentThreadId: ThreadId.makeUnsafe("root-parent"),
          createdAt: "2026-03-08T04:00:00.000Z",
        }),
        makeThread("root-other", { title: "Root Other", createdAt: "2026-03-08T06:00:00.000Z" }),
      ],
    });

    const toggle = await waitForThreadToggle("root-parent");
    toggle.focus();
    toggle.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );

    await vi.waitFor(() => {
      expect(document.querySelector('[data-sidebar-thread-id="child-hidden"]')).toBeTruthy();
      expect(router.state.location.pathname).toBe("/root-other");
      expect(document.querySelector('[data-testid="active-thread-view"]')?.textContent).toBe(
        "Root Other",
      );
    });
  });

  it("navigates to a child thread when the child row is clicked", async () => {
    const { router } = await renderSidebarApp({
      initialEntries: ["/root-parent"],
      threads: [
        makeThread("root-parent", { title: "Root Parent", createdAt: "2026-03-08T05:00:00.000Z" }),
        makeThread("child-target", {
          title: "Child Target",
          parentThreadId: ThreadId.makeUnsafe("root-parent"),
          createdAt: "2026-03-08T04:00:00.000Z",
        }),
      ],
    });

    const toggle = await waitForThreadToggle("root-parent");
    await toggle.click();
    const childRow = await waitForThreadRow("child-target");
    await childRow.click();

    await vi.waitFor(() => {
      expect(router.state.location.pathname).toBe("/child-target");
      expect(document.querySelector('[data-testid="active-thread-view"]')?.textContent).toBe(
        "Child Target",
      );
    });
  });
});
