import {
  EnvironmentId,
  PIPELINE_COLUMNS,
  PIPELINE_COLUMN_LABELS,
  PIPELINE_DEFAULT_LIMIT,
  ProjectId,
  type PipelineCard,
  type PipelineMutation,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { Columns3Icon, ListIcon, PlusIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState, type FormEvent, type ReactNode } from "react";

import { WorkspacePageHeader } from "../../components/WorkspacePageHeader";
import { Button } from "../../components/ui/button";
import { SidebarInset } from "../../components/ui/sidebar";
import { isElectron } from "../../env";
import {
  useConnectedEnvironmentIds,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { mutate, pipelineBoardAtom, pipelineProjectsAtom } from "./api";

const selectClass = "h-8 max-w-full rounded-md border bg-background px-2 text-sm";
const inputClass = "w-full rounded-md border bg-background px-2 py-1.5 text-sm";
const runLabel: Record<PipelineCard["runState"], string> = {
  running: "Running",
  pause_requested: "Pause requested",
  pausing: "Pausing",
  paused: "Paused",
  stopping: "Stopping",
};
type Submit = (action: PipelineMutation) => Promise<boolean>;

export function PipelinePage() {
  const gt = useGT();
  const { environments } = useEnvironments();
  const primary = usePrimaryEnvironmentId();
  const [hub, setHub] = useState<EnvironmentId | null>(() => {
    const saved = window.localStorage.getItem("pipeline:hub");
    return saved ? EnvironmentId.make(saved) : null;
  });
  const selected = environments.some((environment) => environment.environmentId === hub)
    ? hub
    : (primary ?? environments[0]?.environmentId ?? null);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <WorkspacePageHeader electron={isElectron} className="border-b">
        <h1 className="mr-auto text-sm font-semibold">
          <T>Pipeline</T>
        </h1>
        {environments.length > 1 && (
          <select
            aria-label={gt("Pipeline hub")}
            className={selectClass}
            value={selected ?? ""}
            onChange={(event) => {
              setHub(EnvironmentId.make(event.target.value));
              window.localStorage.setItem("pipeline:hub", event.target.value);
            }}
          >
            {environments.map((environment) => (
              <option key={environment.environmentId} value={environment.environmentId}>
                {environment.label}
              </option>
            ))}
          </select>
        )}
      </WorkspacePageHeader>
      {selected ? (
        <TaskBoard key={selected} hub={selected} />
      ) : (
        <p className="p-4 text-sm">
          <T>Connect to the Pipeline hub.</T>
        </p>
      )}
    </SidebarInset>
  );
}

function TaskBoard({ hub }: { hub: EnvironmentId }) {
  const gt = useGT();
  const connected = useConnectedEnvironmentIds();
  const boardQuery = useEnvironmentQuery(pipelineBoardAtom(hub));
  const { data: board, error: boardError } = boardQuery;
  const [actionError, setActionError] = useState<string | null>(null);
  const [chosenHost, setHost] = useState("");
  const [chosenProject, setProject] = useState("");
  const [filter, setFilter] = useState("open");
  const [view, setView] = useState(() =>
    window.localStorage.getItem("pipeline:view") === "board" ? "board" : "list",
  );
  const [creating, setCreating] = useState(false);
  const [settings, setSettings] = useState(false);
  const [busy, setBusy] = useState(false);

  const refreshBoard = useEffectEvent(() => {
    if (!boardQuery.isPending && document.visibilityState === "visible") boardQuery.refresh();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Refresh the remote ledger while the board stays open.
  useEffect(() => {
    const timer = setInterval(refreshBoard, 2500);
    return () => clearInterval(timer);
  }, []);

  const hostOptions = new Map(board?.hosts.map(({ id, label }) => [id, label]));
  for (const card of board?.cards ?? []) {
    if (!hostOptions.has(card.hostId)) hostOptions.set(card.hostId, card.hostId);
  }
  const hostId =
    [...hostOptions.keys()].find((id) => id === chosenHost) ??
    hostOptions.keys().next().value ??
    null;

  const projectsAtom = hostId ? pipelineProjectsAtom(hub, hostId) : null;
  const { data: availableProjects, error: projectError } = useEnvironmentQuery(projectsAtom);
  const projects = new Map(availableProjects?.map(({ projectId, title }) => [projectId, title]));
  for (const card of board?.cards ?? []) {
    if (card.hostId === hostId && !projects.has(card.projectId))
      projects.set(card.projectId, card.projectId);
  }
  const projectId =
    [...projects.keys()].find((id) => id === chosenProject) ?? projects.keys().next().value ?? null;
  const projectCards =
    board?.cards.filter((card) => card.hostId === hostId && card.projectId === projectId) ?? [];
  const cards = projectCards.filter((card) => {
    switch (filter) {
      case "open":
        return card.column !== "done";
      case "attention":
        return (
          card.column !== "done" &&
          !!(card.attentionReason || card.launchError || card.controlError)
        );
      case "queued":
        return card.waitingReason !== null;
      case "all":
        return true;
      default:
        return card.column === filter;
    }
  });
  const occupancy = projectCards.filter((card) => card.occupiesSlot).length;
  const waiting = projectCards.filter((card) => card.waitingReason !== null).length;
  const limit =
    board?.limits.find((target) => target.hostId === hostId && target.projectId === projectId)
      ?.limit ?? PIPELINE_DEFAULT_LIMIT;

  const submit: Submit = async (action) => {
    setBusy(true);
    setActionError(null);
    try {
      await mutate(hub, action);
      boardQuery.refresh();
      return true;
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const changeView = (value: "board" | "list") => {
    setView(value);
    window.localStorage.setItem("pipeline:view", value);
  };
  const cardView = (card: PipelineCard, showStage: boolean) => (
    <TaskCard
      key={card.id}
      card={card}
      showStage={showStage}
      hub={hub}
      direct={connected.includes(card.hostId)}
      submit={submit}
      busy={busy}
    />
  );

  if (!board)
    return (
      <p className="p-4 text-sm" role={boardError ? "alert" : "status"}>
        {boardError ?? gt("Loading tasks…")}
      </p>
    );
  if (!board.enabled)
    return (
      <p className="p-4 text-sm">
        <T>Pipeline is off on this environment.</T>
      </p>
    );
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="space-y-3 border-b px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label={gt("Machine")}
            className={selectClass}
            value={hostId ?? ""}
            onChange={(event) => {
              setHost(event.target.value);
              setProject("");
              setFilter("open");
            }}
          >
            {!hostId && (
              <option value="">
                <T>No linked machines</T>
              </option>
            )}
            {[...hostOptions.entries()].map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
          <select
            aria-label={gt("Project")}
            className={selectClass}
            value={projectId ?? ""}
            onChange={(event) => {
              setProject(event.target.value);
              setFilter("open");
            }}
          >
            {!projectId && (
              <option value="">
                <T>No projects</T>
              </option>
            )}
            {[...projects.entries()].map(([id, title]) => (
              <option key={id} value={id}>
                {title}
              </option>
            ))}
          </select>
          <div
            role="group"
            aria-label={gt("Layout")}
            className="flex gap-1 rounded-md border p-0.5"
          >
            <Button
              size="sm"
              variant={view === "list" ? "secondary" : "ghost"}
              aria-pressed={view === "list"}
              onClick={() => changeView("list")}
            >
              <ListIcon />
              <T>Tasks</T>
            </Button>
            <Button
              size="sm"
              variant={view === "board" ? "secondary" : "ghost"}
              aria-pressed={view === "board"}
              onClick={() => changeView("board")}
            >
              <Columns3Icon />
              <T>Board</T>
            </Button>
          </div>
          <select
            aria-label={gt("Filter tasks")}
            className={selectClass}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          >
            <option value="open">
              <T>Open</T>
            </option>
            <option value="attention">
              <T>Needs you</T>
            </option>
            <option value="queued">
              <T>Queued</T>
            </option>
            <option value="all">
              <T>All</T>
            </option>
            {PIPELINE_COLUMNS.map((stage) => (
              <option key={stage} value={stage}>
                {PIPELINE_COLUMN_LABELS[stage]}
              </option>
            ))}
          </select>
          <div className="ml-auto flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!projectId}
              onClick={() => setSettings(!settings)}
            >
              <T>Settings</T>
            </Button>
            <Button
              size="sm"
              disabled={
                !projectId ||
                !hostId ||
                !projects.has(projectId) ||
                !board.hosts.some((host) => host.id === hostId)
              }
              onClick={() => setCreating(!creating)}
            >
              <PlusIcon />
              <T>New task</T>
            </Button>
          </div>
        </div>
        <div className="text-xs text-muted-foreground" aria-live="polite">
          {projectId
            ? gt("{occupancy} / {limit} active · {waiting} queued", { occupancy, limit, waiting })
            : hostId
              ? gt("Choose a project")
              : gt("Link a machine from Settings → Environments.")}
        </div>
        {(boardError || projectError || actionError) && (
          <p role="alert" className="text-sm text-destructive">
            {actionError ?? boardError ?? projectError}
          </p>
        )}
        {settings && hostId && projectId && (
          <form
            className="flex items-end gap-2"
            key={`${hostId}:${projectId}:${limit}`}
            onSubmit={(event) => {
              event.preventDefault();
              const value = Number(new FormData(event.currentTarget).get("limit"));
              void submit({ kind: "limit", hostId, projectId, limit: value });
            }}
          >
            <label className="grid gap-1 text-xs">
              <T>Concurrent tasks</T>
              <input
                className={inputClass}
                name="limit"
                type="number"
                min={1}
                max={32}
                defaultValue={limit}
                required
              />
            </label>
            <Button size="sm" disabled={busy} type="submit">
              <T>Save limit</T>
            </Button>
          </form>
        )}
        {creating && hostId && projectId && (
          <NewTask
            key={`${hostId}:${projectId}`}
            hostId={hostId}
            projectId={projectId}
            busy={busy}
            submit={submit}
            onClose={() => setCreating(false)}
          />
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {cards.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            <T>No tasks match this view.</T>
          </p>
        ) : view === "list" ? (
          <ul className="space-y-2">{cards.map((card) => cardView(card, true))}</ul>
        ) : (
          <div className="flex flex-col gap-3 md:flex-row md:items-start">
            {PIPELINE_COLUMNS.map((stage) => {
              const group = cards.filter((card) => card.column === stage);
              return group.length === 0 ? null : (
                <section key={stage} className="rounded-lg bg-muted/45 p-2 md:w-64 md:shrink-0">
                  <h2 className="mb-2 px-1 text-xs font-semibold">
                    {PIPELINE_COLUMN_LABELS[stage]}{" "}
                    <span className="text-muted-foreground">{group.length}</span>
                  </h2>
                  <ul className="space-y-2">{group.map((card) => cardView(card, false))}</ul>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function NewTask({
  hostId,
  projectId,
  busy,
  submit,
  onClose,
}: {
  hostId: EnvironmentId;
  projectId: ProjectId;
  busy: boolean;
  submit: Submit;
  onClose: () => void;
}) {
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const start = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") === "start";
    const mode = form.get("mode");
    const size = form.get("size");
    const success = await submit({
      kind: "create",
      card: {
        hostId,
        projectId,
        start,
        title: String(form.get("title") ?? ""),
        body: String(form.get("body") ?? ""),
        baseRef: String(form.get("baseRef") ?? ""),
        mode: mode === "auto" || mode === "full-auto" ? mode : "manual",
        size: size === "small" ? size : "standard",
        shapeReview: form.has("shapeReview"),
      },
    });
    if (success) onClose();
  }
  return (
    <form
      onSubmit={(event) => void save(event)}
      className="grid max-w-2xl gap-3 rounded-lg border p-3"
    >
      <label className="grid gap-1 text-xs">
        <T>Title</T>
        <input className={inputClass} name="title" required maxLength={120} />
      </label>
      <label className="grid gap-1 text-xs">
        <T>Context</T>
        <textarea className={inputClass} name="body" rows={3} maxLength={20_000} />
      </label>
      <div className="flex flex-wrap items-end gap-2">
        <label className="grid gap-1 text-xs">
          <T>Base ref</T>
          <input
            className={inputClass}
            name="baseRef"
            defaultValue="HEAD"
            maxLength={250}
            required
          />
        </label>
        <label className="grid gap-1 text-xs">
          <T>Mode</T>
          <select className={selectClass} name="mode">
            <option value="manual">
              <T>Manual</T>
            </option>
            <option value="auto">
              <T>Auto</T>
            </option>
            <option value="full-auto">
              <T>Full auto</T>
            </option>
          </select>
        </label>
        <label className="grid gap-1 text-xs">
          <T>Size</T>
          <select className={selectClass} name="size">
            <option value="standard">
              <T>Standard</T>
            </option>
            <option value="small">
              <T>Small</T>
            </option>
          </select>
        </label>
        <label className="flex h-8 items-center gap-2 text-xs">
          <input type="checkbox" name="shapeReview" defaultChecked />
          <T>Shape review</T>
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={busy} type="submit">
          <T>Save</T>
        </Button>
        <Button size="sm" value="start" disabled={busy} type="submit">
          <T>Save and start</T>
        </Button>
        <Button variant="ghost" size="sm" type="button" onClick={onClose}>
          <T>Cancel</T>
        </Button>
      </div>
    </form>
  );
}

function TaskCard({
  card,
  showStage,
  hub,
  direct,
  submit,
  busy,
}: {
  card: PipelineCard;
  showStage: boolean;
  hub: EnvironmentId;
  direct: boolean;
  submit: Submit;
  busy: boolean;
}) {
  const gt = useGT();
  const thread = card.leadThreadId;
  const active = card.startRequested && card.column !== "done";
  const canStop = active && ["running", "pause_requested", "pausing"].includes(card.runState);
  const title: ReactNode =
    thread === null ? (
      card.title
    ) : direct ? (
      <Link
        to="/$environmentId/$threadId"
        params={{ environmentId: card.hostId, threadId: thread }}
        className="hover:underline"
      >
        {card.title}
      </Link>
    ) : (
      <Link
        to="/linked/$viaEnvironmentId/$linkedEnvironmentId/$linkedThreadId"
        params={{ viaEnvironmentId: hub, linkedEnvironmentId: card.hostId, linkedThreadId: thread }}
        className="hover:underline"
      >
        {card.title}
      </Link>
    );
  return (
    <li className="space-y-2 rounded-md border bg-background p-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-1">
        <h3 className="break-words text-sm font-medium">{title}</h3>
        {showStage && (
          <span className="text-xs text-muted-foreground">
            {PIPELINE_COLUMN_LABELS[card.column]}
          </span>
        )}
      </div>
      {!card.startRequested && (
        <p className="text-xs text-muted-foreground">
          <T>Not started</T>
        </p>
      )}
      {card.runState !== "running" && (
        <p className="text-xs font-medium">{runLabel[card.runState]}</p>
      )}
      {card.waitingReason && (
        <p className="text-xs text-muted-foreground">
          {card.waitingReason}
          {card.runNext ? ` · ${gt("Run next")}` : ""}
        </p>
      )}
      {card.attentionReason && (
        <p className="break-words text-xs">
          {gt("Needs you · {reason}", { reason: card.attentionReason })}
        </p>
      )}
      {(card.launchError || card.controlError) && (
        <p className="break-words text-xs text-destructive">
          {card.launchError ?? card.controlError}
        </p>
      )}
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground">
          <T>Details</T>
        </summary>
        {card.body && <p className="my-2 whitespace-pre-wrap break-words">{card.body}</p>}
        {card.result && <p className="my-2 whitespace-pre-wrap break-words">{card.result}</p>}
        <div className="mt-2 flex flex-wrap gap-1.5">
          {!card.startRequested && (
            <CardButton busy={busy} submit={submit} action={{ kind: "start", id: card.id }}>
              <T>Start</T>
            </CardButton>
          )}
          {card.runState === "running" && card.launchError && (
            <CardButton busy={busy} submit={submit} action={{ kind: "retry", id: card.id }}>
              <T>Retry</T>
            </CardButton>
          )}
          {active && card.runState === "running" && (
            <CardButton busy={busy} submit={submit} action={{ kind: "pause", id: card.id }}>
              <T>Pause</T>
            </CardButton>
          )}
          {canStop && (
            <CardButton busy={busy} submit={submit} action={{ kind: "stop", id: card.id }}>
              <T>Stop now</T>
            </CardButton>
          )}
          {active && card.runState === "paused" && (
            <CardButton busy={busy} submit={submit} action={{ kind: "resume", id: card.id }}>
              <T>Resume</T>
            </CardButton>
          )}
          {card.waitingReason && (
            <CardButton
              busy={busy}
              submit={submit}
              action={{ kind: card.runNext ? "clear_run_next" : "run_next", id: card.id }}
            >
              {card.runNext ? gt("Clear run next") : gt("Run next")}
            </CardButton>
          )}
          {active && card.runState === "running" && card.leadThreadId && (
            <select
              aria-label={gt("Move {title}", { title: card.title })}
              className={selectClass}
              disabled={busy}
              value={card.column}
              onChange={(event) => {
                const column = PIPELINE_COLUMNS.find((stage) => stage === event.target.value);
                if (column) void submit({ kind: "move", id: card.id, column });
              }}
            >
              {PIPELINE_COLUMNS.filter((stage) => stage !== "backlog").map((stage) => (
                <option key={stage} value={stage}>
                  {PIPELINE_COLUMN_LABELS[stage]}
                </option>
              ))}
            </select>
          )}
        </div>
      </details>
    </li>
  );
}

function CardButton({
  busy,
  submit,
  action,
  children,
}: {
  busy: boolean;
  submit: Submit;
  action: PipelineMutation;
  children: ReactNode;
}) {
  return (
    <Button size="sm" variant="outline" disabled={busy} onClick={() => void submit(action)}>
      {children}
    </Button>
  );
}
