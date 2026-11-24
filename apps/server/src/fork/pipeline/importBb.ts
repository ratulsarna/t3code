// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- The import runs against offline SQLite snapshots.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { normalizePullRequestUrl } from "./github.ts";
import { normalizeGithubIssueUrl } from "./issue.ts";
import { initialGithubState, githubStatusSchema } from "./github-types.ts";
import { z } from "zod";
import { ModelSelection } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { createCardStore } from "./store.ts";

const historyPrefix = "bb-";
const cardIdFor = (source: string) => {
  const hash = NodeCrypto.createHash("sha256").update(`pipeline:bb:${source}`).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
};

interface ThreadMapping {
  environmentId: string;
  threads: ReadonlyMap<string, string>;
  children: ReadonlyMap<string, ReadonlyArray<string>>;
}

function readHistoryMap(home: string): ThreadMapping {
  const state = NodePath.join(home, "userdata");
  const environmentId = NodeFS.readFileSync(NodePath.join(state, "environment-id"), "utf8").trim();
  if (!environmentId) throw new Error("History home has no environment ID.");
  using db = new NodeSqlite.DatabaseSync(NodePath.join(state, "statev2.sqlite"), {
    readOnly: true,
  });
  const threads = new Map<string, string>();
  const children = new Map<string, string[]>();
  for (const row of db
    .prepare(`SELECT thread_id, payload_json FROM orchestration_v2_projection_threads
    WHERE thread_id LIKE 'bb-%' AND deleted_at IS NULL`)
    .all()) {
    const id = String(row.thread_id);
    threads.set(id.slice(historyPrefix.length), id);
    const payload = JSON.parse(String(row.payload_json)) as {
      lineage?: { parentThreadId?: string | null };
    };
    const parent = payload.lineage?.parentThreadId;
    if (parent?.startsWith(historyPrefix)) {
      const list = children.get(parent) ?? [];
      list.push(id);
      children.set(parent, list);
    }
  }
  return { environmentId, threads, children };
}

const string = (value: NodeSqlite.SQLOutputValue | undefined) =>
  typeof value === "string" ? value : null;
const isThreadField = (key: string) => /(?:^|[A-Z_])thread_?id$/i.test(key);

function mapReviewThreads(
  value: unknown,
  map: ThreadMapping,
  linked: Set<string>,
  key = "",
): unknown {
  if (typeof value === "string" && isThreadField(key)) {
    const mapped = map.threads.get(value);
    if (mapped !== undefined) linked.add(mapped);
    return mapped ?? null;
  }
  if (Array.isArray(value)) return value.map((item) => mapReviewThreads(item, map, linked));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([field, item]) => [
        field,
        mapReviewThreads(item, map, linked, field),
      ]),
    );
  }
  return value;
}

function descendants(threadId: string | null, map: ThreadMapping, result: Set<string>) {
  if (!threadId) return;
  const children = [...(map.children.get(threadId) ?? [])];
  for (const child of children)
    if (!result.has(child)) {
      result.add(child);
      descendants(child, map, result);
    }
}

const resumeTargets = z.record(
  z.string(),
  z
    .object({
      branch: z.string().min(1).max(250).optional(),
      repository: z
        .string()
        .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
        .optional(),
      hostId: z.string().min(1).optional(),
      projectId: z.string().min(1).optional(),
    })
    .strict()
    .refine((target) => (target.hostId === undefined) === (target.projectId === undefined)),
);

const legacyGithubState = z.object({
  status: z.unknown().optional(),
  observed: z.record(z.string(), z.string()).optional(),
  batch: z
    .object({ state: z.string(), feedback: z.array(z.object({ id: z.string() })) })
    .nullable()
    .optional(),
});

function importedGithub(url: string | null, value: string | null, done: boolean) {
  if (!url) return null;
  const state = initialGithubState(url);
  if (value) {
    const legacy = legacyGithubState.safeParse(JSON.parse(value));
    if (legacy.success) {
      const status = githubStatusSchema.safeParse(legacy.data.status);
      if (status.success)
        state.status = {
          ...status.data,
          url,
          batchId: null,
          manualReviewPending: false,
          followup: null,
          syncedAt: null,
        };
      state.observed = legacy.data.observed ?? {};
      // A batch still in progress belongs in the new lead's review after resume.
      const batch = legacy.data.batch;
      if (!done && batch && batch.state !== "handled") {
        for (const item of batch.feedback) delete state.observed[item.id];
      }
    }
  }
  return JSON.stringify(state);
}

const bbLeadSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1),
  reasoningLevel: z.string().nullable().optional(),
});
const bbDefaultSchema = z.object({
  leadProviderId: z.string().min(1),
  leadModel: z.string().min(1),
  leadReasoningLevel: z.string().nullable().optional(),
});
const parseNativeLead = Schema.decodeUnknownSync(ModelSelection);

function importLead(value: z.infer<typeof bbLeadSchema>) {
  const claude = value.providerId === "claude-code";
  return parseNativeLead({
    instanceId: claude ? "claudeAgent" : value.providerId,
    model: value.model,
    ...(value.reasoningLevel
      ? {
          options: [
            {
              id: claude ? "effort" : "reasoningEffort",
              value: value.reasoningLevel,
            },
          ],
        }
      : {}),
  });
}

export function importBbPipeline(
  sourcePath: string,
  targetPath: string,
  historyHome: string,
  modelsPath: string,
  targetsPath?: string,
  bbSettingsPath?: string,
) {
  if (
    NodeFS.existsSync(targetPath) &&
    NodeFS.realpathSync(sourcePath) === NodeFS.realpathSync(targetPath)
  ) {
    throw new Error("The bb snapshot and Pipeline database must be separate files.");
  }
  const map = readHistoryMap(historyHome);
  const targets = targetsPath
    ? resumeTargets.parse(JSON.parse(NodeFS.readFileSync(targetsPath, "utf8")))
    : {};
  const defaults = bbSettingsPath
    ? bbDefaultSchema.parse(JSON.parse(NodeFS.readFileSync(bbSettingsPath, "utf8")))
    : null;
  const models = NodeFS.readFileSync(modelsPath, "utf8");
  JSON.parse(models);
  using source = new NodeSqlite.DatabaseSync(sourcePath, { readOnly: true });
  using target = new NodeSqlite.DatabaseSync(targetPath);
  createCardStore(target);
  const counts = {
    cards: 0,
    done: 0,
    history: 0,
    reviewRecords: 0,
    snapshots: 0,
    leadLinks: 0,
    childLinks: 0,
    skipped: 0,
  };

  target.exec("BEGIN IMMEDIATE");
  try {
    target.prepare("INSERT OR IGNORE INTO reviewer_models VALUES (1, ?)").run(models);
    if (defaults)
      target.prepare("INSERT OR IGNORE INTO pipeline_settings VALUES (1, ?)").run(
        JSON.stringify(
          importLead({
            providerId: defaults.leadProviderId,
            model: defaults.leadModel,
            reasoningLevel: defaults.leadReasoningLevel,
          }),
        ),
      );
    for (const row of source.prepare(`SELECT * FROM cards ORDER BY created_at, id`).iterate()) {
      const sourceId = String(row.id);
      const id = cardIdFor(sourceId);
      if (target.prepare("SELECT 1 FROM legacy_cards WHERE source_id = ?").get(sourceId)) {
        if (targets[sourceId]) {
          target
            .prepare(`UPDATE legacy_cards SET resume_target = ? WHERE source_id = ?
            AND EXISTS (SELECT 1 FROM cards WHERE id = legacy_cards.card_id AND historical = 1
              AND "column" <> 'done' AND run_state = 'paused' AND operation IS NULL)`)
            .run(JSON.stringify(targets[sourceId]), sourceId);
        }
        counts.skipped++;
        continue;
      }
      const leadId = map.threads.get(String(row.lead_thread_id)) ?? null;
      const issue = string(row.issue_url);
      const pr = typeof row.pr_url === "string" ? normalizePullRequestUrl(row.pr_url) : null;
      const done = row.column === "done";
      const links = new Set<string>();
      descendants(leadId, map, links);
      target
        .prepare(`INSERT INTO cards (id, project_id, host_id, title, body, base_ref, mode, size,
        shape_review, "column", run_state, start_requested, lead_thread_id, lead_execution, attention_reason, launch_error,
        control_error, revision, created_at, updated_at, issue_url, issue_snapshot, pr_url, github_state,
        historical, lead_environment_id)
        VALUES (?, ?, ?, ?, ?, 'HEAD', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`)
        .run(
          id,
          historyPrefix + row.project_id,
          map.environmentId,
          String(row.title),
          String(row.body ?? ""),
          string(row.mode) ?? "manual",
          string(row.size) ?? "standard",
          Number(row.shape_review ?? 0),
          String(row.column),
          done ? "running" : "paused",
          Number(row.start_requested ?? 0),
          leadId,
          typeof row.lead_execution === "string"
            ? JSON.stringify(importLead(bbLeadSchema.parse(JSON.parse(row.lead_execution))))
            : null,
          string(row.attention_reason),
          string(row.launch_error),
          string(row.control_error),
          Number(row.revision ?? 0),
          Number(row.created_at),
          Number(row.updated_at),
          issue === null ? null : normalizeGithubIssueUrl(issue),
          string(row.imported_issue),
          pr,
          importedGithub(pr, string(row.github_state), done),
          leadId === null ? null : map.environmentId,
        );
      const { attachments: _attachments, ...record } = row;
      target
        .prepare("INSERT INTO legacy_cards VALUES (?, ?, ?, ?)")
        .run(
          id,
          sourceId,
          JSON.stringify(record),
          targets[sourceId] ? JSON.stringify(targets[sourceId]) : null,
        );
      for (const history of source
        .prepare("SELECT * FROM card_history WHERE card_id = ? ORDER BY id")
        .iterate(sourceId)) {
        const thread = map.threads.get(String(history.thread_id)) ?? null;
        if (thread && thread !== leadId) links.add(thread);
        target
          .prepare(`INSERT INTO card_history (card_id, at, kind, source, from_column, to_column, thread_id, note)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            id,
            Number(history.at),
            String(history.kind),
            String(history.source),
            string(history.from_column),
            string(history.to_column),
            thread,
            string(history.note),
          );
        counts.history++;
      }
      const review = source
        .prepare("SELECT record, warnings FROM review_records WHERE card_id = ?")
        .get(sourceId);
      if (review) {
        const record = mapReviewThreads(JSON.parse(String(review.record)), map, links);
        target
          .prepare("INSERT INTO review_records VALUES (?, ?, ?)")
          .run(id, JSON.stringify(record), String(review.warnings));
        counts.reviewRecords++;
      }
      const snapshot = source
        .prepare("SELECT snapshot FROM instruction_snapshots WHERE card_id = ?")
        .get(sourceId);
      if (snapshot) {
        target
          .prepare("INSERT INTO instruction_snapshots VALUES (?, ?, ?, '')")
          .run(id, String(snapshot.snapshot), NodeCrypto.randomBytes(32).toString("base64url"));
        counts.snapshots++;
      }
      for (const child of links)
        if (child !== leadId) {
          target
            .prepare("INSERT OR IGNORE INTO imported_thread_links VALUES (?, ?)")
            .run(id, child);
          counts.childLinks++;
        }
      counts.cards++;
      counts.done += Number(done);
      counts.leadLinks += Number(leadId !== null);
    }
    target.exec("COMMIT");
    return counts;
  } catch (error) {
    target.exec("ROLLBACK");
    throw error;
  }
}

if (import.meta.main) {
  const [snapshot, target, historyHome, models, resumeTargetsPath, bbSettingsPath] =
    process.argv.slice(2);
  if (!snapshot || !target || !historyHome || !models) {
    throw new Error(
      "Usage: importBb.ts BB_SNAPSHOT PIPELINE_SQLITE HISTORY_HOME REVIEWER_MODELS_JSON [RESUME_TARGETS_JSON] [BB_LEAD_SETTINGS_JSON]",
    );
  }
  console.log(
    JSON.stringify(
      importBbPipeline(snapshot, target, historyHome, models, resumeTargetsPath, bbSettingsPath),
    ),
  );
}
