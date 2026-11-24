import { useGT } from "gt-react";
import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef, ServerConfig } from "@t3tools/contracts";
import {
  resolveSidebarFolderDot,
  resolveThreadLastVisitedAt,
} from "../../components/Sidebar.logic";
import { useQuietThreadShell } from "../../state/entities";
import { useUiStateStore } from "../../uiStateStore";
import { cn } from "../../lib/utils";

type Bot = NonNullable<ServerConfig["bots"]>[number];

const DOT_STYLE = {
  attention: "bg-warning",
  failed: "bg-error",
  unread: "bg-success",
  working: "bg-info",
};

function BotRow({
  bot,
  threadRef,
  selected,
  openThread,
}: {
  bot: Bot;
  threadRef: ScopedThreadRef;
  selected: boolean;
  openThread: (threadRef: ScopedThreadRef) => void;
}) {
  const gt = useGT();
  const thread = useQuietThreadShell(threadRef);
  const localVisit = useUiStateStore(
    (state) => state.threadLastVisitedAtById[scopedThreadKey(threadRef)],
  );
  if (thread?.archivedAt != null) return null;
  const dot =
    thread &&
    resolveSidebarFolderDot([
      {
        ...thread,
        lastVisitedAt: resolveThreadLastVisitedAt(thread.lastVisitedAt, localVisit),
      },
    ]);
  const attention =
    dot === "attention"
      ? gt("Needs attention")
      : dot === "failed"
        ? gt("Failed")
        : dot === "unread"
          ? gt("Unread")
          : dot === "working"
            ? gt("Working")
            : undefined;

  return (
    <button
      type="button"
      aria-current={selected ? "page" : undefined}
      onClick={() => openThread(threadRef)}
      className={cn(
        "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-start hover:bg-accent",
        selected && "bg-accent",
      )}
    >
      {bot.avatar ? (
        <img src={bot.avatar} alt="" className="size-7 shrink-0 rounded-full object-cover" />
      ) : (
        <span
          aria-hidden
          className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-xs"
        >
          {bot.name.slice(0, 1)}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{bot.name}</span>
        {bot.subtitle && (
          <span className="block truncate text-xs text-muted-foreground">{bot.subtitle}</span>
        )}
      </span>
      {dot && (
        <span
          role="img"
          aria-label={attention}
          className={cn("size-2 shrink-0 rounded-full", DOT_STYLE[dot])}
        />
      )}
    </button>
  );
}

export function BotsSection({
  configs,
  activeThreadKey,
  openThread,
}: {
  configs: ReadonlyMap<EnvironmentId, EnvironmentServerConfig>;
  activeThreadKey: string | null;
  openThread: (threadRef: ScopedThreadRef) => void;
}) {
  const gt = useGT();
  const rows = Array.from(configs, ([environmentId, config]) =>
    (config.bots ?? []).map((bot) => ({
      bot,
      threadRef: scopeThreadRef(environmentId, bot.threadId),
    })),
  ).flat();
  if (rows.length === 0) return null;
  return (
    <section aria-label={gt("Bots")} className="mb-2 flex flex-col gap-px">
      <h2 className="px-2 py-1 text-xs font-medium text-muted-foreground">{gt("Bots")}</h2>
      {rows.map(({ bot, threadRef }) => (
        <BotRow
          key={scopedThreadKey(threadRef)}
          bot={bot}
          threadRef={threadRef}
          selected={activeThreadKey === scopedThreadKey(threadRef)}
          openThread={openThread}
        />
      ))}
    </section>
  );
}
