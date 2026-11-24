import { Database } from "bun:sqlite";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import { normalizeAttachmentReferences } from "./attachmentReferences.ts";

const [checkout, snapshot, selection] = process.argv.slice(2);
if (!checkout || !snapshot || !selection) {
  throw new Error(
    "Usage: bun decode.mjs BB_CHECKOUT SQLITE_BACKUP SAMPLE_IDS_FILE|--all|--benchmark",
  );
}

const fromBb = (file) => import(NodeURL.pathToFileURL(NodePath.resolve(checkout, file)).href);
const bbDbRequire = NodeModule.createRequire(
  NodePath.resolve(checkout, "packages/db/package.json"),
);
const [
  { parseStoredThreadEvent, projectAttachmentPaths, threadScope, turnScope },
  { hydrateRetainedEventOutputRows },
  { drizzle },
  {
    buildThreadTimelineFromEvents,
    compactThreadTimelineSummaryEvents,
    THREAD_TIMELINE_EXCLUDED_EVENT_TYPES,
  },
] = await Promise.all([
  fromBb("packages/domain/src/index.ts"),
  fromBb("packages/db/src/data/retained-event-outputs.ts"),
  import(NodeURL.pathToFileURL(bbDbRequire.resolve("drizzle-orm/bun-sqlite")).href),
  fromBb("packages/thread-view/src/index.ts"),
]);

const uploadedPaths = (path) =>
  projectAttachmentPaths([{ type: "localFile", path }], "best-effort");

const started = performance.now();
const benchmark = selection === "--benchmark";
const requested =
  benchmark || selection === "--all"
    ? null
    : new Set(JSON.parse(NodeFS.readFileSync(selection, "utf8")));
const db = new Database(snapshot, { readonly: true, strict: true });
db.exec("PRAGMA cache_size = -65536; PRAGMA mmap_size = 1073741824");
const hydrated = drizzle({ client: db });
const excluded = new Set(THREAD_TIMELINE_EXCLUDED_EVENT_TYPES);
const eventQuery = db.query(`
  SELECT id, thread_id AS threadId, scope_kind AS scopeKind, turn_id AS turnId,
    provider_thread_id AS providerThreadId, sequence, type, data, created_at AS createdAt
  FROM events WHERE thread_id = ? ORDER BY sequence
`);
const attachmentQuery = db.query(`
  SELECT a.project_id, a.stored_path, a.original_name, a.mime_type, a.size_bytes
  FROM project_attachment_threads AS link
  JOIN project_attachments AS a ON a.id = link.attachment_id
  WHERE link.thread_id = ? ORDER BY a.stored_path
`);
const threads = db
  .query(`
  SELECT t.id, t.project_id, p.name AS project_name, p.git_remote_url AS project_remote,
    p.sort_key AS project_sort_key, t.provider_id,
    COALESCE(t.model_override, d.model) AS model, t.title, t.title_fallback, t.status,
    t.visibility, t.section_id, t.archived_at, t.pinned_at, t.pin_sort_key, t.last_read_at,
    t.created_at, t.updated_at, t.source_thread_id, t.origin_kind, t.parent_thread_id,
    t.lifecycle_owner_thread_id, t.environment_id, e.path, e.branch_name, e.host_id,
    h.name AS host_name
  FROM threads AS t
  JOIN projects AS p ON p.id = t.project_id
  LEFT JOIN project_execution_defaults AS d
    ON d.project_id = t.project_id AND d.provider_id = t.provider_id
  LEFT JOIN environments AS e ON e.id = t.environment_id
  LEFT JOIN hosts AS h ON h.id = e.host_id
  WHERE t.deleted_at IS NULL
  ORDER BY p.sort_key, t.created_at, t.id
`)
  .all();
const byId = new Map(threads.map((thread) => [thread.id, thread]));
const children = new Map();
for (const thread of threads) {
  if (thread.parent_thread_id !== null) {
    const list = children.get(thread.parent_thread_id) ?? [];
    list.push(thread.id);
    children.set(thread.parent_thread_id, list);
  }
}

function flatten(rows, nested = false) {
  return rows.flatMap((row) => {
    if (row.kind === "turn") return flatten(row.children ?? [], nested);
    if (row.kind === "work" && row.workKind === "delegation") {
      const { childRows, ...activity } = row;
      return [{ ...activity, nested }, ...flatten(childRows ?? [], true)];
    }
    return [{ ...row, nested }];
  });
}

function forkRoot(thread) {
  const seen = new Set();
  let source = thread;
  while (source.origin_kind === "fork" && source.source_thread_id !== null) {
    const parent = byId.get(source.source_thread_id);
    if (!parent || (requested && !requested.has(parent.id)) || seen.has(parent.id)) break;
    seen.add(source.id);
    source = parent;
  }
  return source.id;
}

const stats = {
  threads: 0,
  rawEvents: 0,
  items: 0,
  messages: 0,
  attachmentReferences: 0,
  malformedEvents: {},
  normalizedBytes: 0,
};
for (const thread of threads) {
  if (requested && !requested.has(thread.id)) continue;
  const raw = eventQuery.all(thread.id);
  const candidates = raw.filter(
    (row) => row.type === "item/completed" || row.type === "provider/unhandled",
  );
  const fullOutput = new Map(
    hydrateRetainedEventOutputRows(hydrated, candidates, 0)
      .filter((row, index) => row !== candidates[index])
      .map((row) => [row.id, row]),
  );
  const events = raw.flatMap((stored) => {
    if (excluded.has(stored.type)) return [];
    try {
      return [
        {
          event: parseStoredThreadEvent({
            type: stored.type,
            data: JSON.parse((fullOutput.get(stored.id) ?? stored).data),
            threadId: stored.threadId,
            providerThreadId: stored.providerThreadId,
            scope: stored.scopeKind === "turn" ? turnScope(stored.turnId) : threadScope(),
          }),
          meta: { id: stored.id, seq: stored.sequence, createdAt: stored.createdAt },
        },
      ];
    } catch {
      stats.malformedEvents[stored.type] = (stats.malformedEvents[stored.type] ?? 0) + 1;
      return [];
    }
  });
  const { rows } = buildThreadTimelineFromEvents({
    events: compactThreadTimelineSummaryEvents(events),
    contextWindowEvents: [],
    acceptedClientRequestContext: {
      acceptedClientRequestEvents: [],
      rejectedClientRequestEvents: [],
    },
    options: {
      completedTurnDisplay: "flat",
      includeNestedRows: true,
      omitSettledDelegationChildRows: false,
      includeDiagnosticOperations: false,
      isLatestPage: false,
      providerId: thread.provider_id,
      summarizeShellCommands: false,
      threadStatus: thread.status,
      threadName: thread.title ?? thread.title_fallback ?? "",
      workspaceRoot: thread.path,
    },
  });
  const attachments = attachmentQuery.all(thread.id);
  const inventory = new Set(attachments.map((attachment) => attachment.stored_path));
  const items = flatten(rows)
    .sort((a, b) => a.sourceSeqStart - b.sourceSeqStart)
    .map((row) => normalizeAttachmentReferences(row, uploadedPaths, inventory));
  const root = forkRoot(thread);
  const record = {
    thread,
    links: {
      children: children.get(thread.id) ?? [],
      importedChildren: (children.get(thread.id) ?? []).filter(
        (id) => requested === null || requested.has(id),
      ),
      forkParent: root === thread.id ? null : thread.source_thread_id,
      forkRoot: root,
    },
    items,
    attachments,
  };
  const line = JSON.stringify(record);
  stats.threads++;
  stats.rawEvents += raw.length;
  stats.items += items.length;
  stats.messages += items.filter(
    (item) =>
      item.kind === "conversation" &&
      !item.nested &&
      (item.role === "assistant" || item.turnRequest.status === "accepted"),
  ).length;
  stats.attachmentReferences += attachments.length;
  stats.normalizedBytes += Buffer.byteLength(line) + 1;
  if (!benchmark && !process.stdout.write(line + "\n"))
    await NodeEvents.once(process.stdout, "drain");
}
if (requested && stats.threads !== requested.size) {
  throw new Error(`Projected ${stats.threads} of ${requested.size} requested bb threads`);
}
db.close();
console.error(JSON.stringify({ ...stats, seconds: (performance.now() - started) / 1000 }));
