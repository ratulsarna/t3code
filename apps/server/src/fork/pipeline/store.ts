// @effect-diagnostics nodeBuiltinImport:off -- Synchronous transactions mirror the Pipeline store.
import * as NodeCrypto from "node:crypto";
import type * as NodeSqlite from "node:sqlite";
import {
  PIPELINE_DEFAULT_LIMIT,
  PipelineFailure,
  type PipelineCard,
  type PipelineMutation,
  type PipelineNewCard,
  type PipelineReport,
} from "@t3tools/contracts";
import { EnvironmentId, ProjectId, ThreadId, type PipelineColumn } from "@t3tools/contracts";
import { normalizePullRequestUrl } from "./github.ts";
import type { GithubSyncState } from "./github-types.ts";
import type { GithubIssueDetails } from "./issue-types.ts";

const migrations = [
  `CREATE TABLE cards (
     id TEXT PRIMARY KEY, project_id TEXT NOT NULL, host_id TEXT NOT NULL,
     title TEXT NOT NULL, body TEXT NOT NULL, base_ref TEXT NOT NULL, lead_execution TEXT,
     mode TEXT NOT NULL, size TEXT NOT NULL, shape_review INTEGER NOT NULL,
     "column" TEXT NOT NULL, run_state TEXT NOT NULL, start_requested INTEGER NOT NULL,
     lead_thread_id TEXT, attention_reason TEXT, result TEXT, launch_error TEXT, control_error TEXT,
     queued_at INTEGER, occupies_slot INTEGER NOT NULL DEFAULT 0,
     operation TEXT, operation_id TEXT, link_identity TEXT,
     revision INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
   ) STRICT;
   CREATE INDEX cards_queue ON cards(project_id, host_id, occupies_slot, queued_at);
   CREATE TABLE card_history (
     id INTEGER PRIMARY KEY, card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
     at INTEGER NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL,
     from_column TEXT, to_column TEXT, thread_id TEXT, note TEXT
   ) STRICT;
   CREATE INDEX history_card ON card_history(card_id, id);
   CREATE TABLE instruction_snapshots (
     card_id TEXT PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
     snapshot TEXT NOT NULL, report_token TEXT NOT NULL, callback_origin TEXT NOT NULL
   ) STRICT;
   CREATE TABLE task_limits (
     project_id TEXT NOT NULL, host_id TEXT NOT NULL, task_limit INTEGER NOT NULL CHECK(task_limit BETWEEN 1 AND 32),
     PRIMARY KEY(project_id, host_id)
   ) STRICT;
   CREATE TABLE run_next (
     project_id TEXT NOT NULL, host_id TEXT NOT NULL,
     card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
     PRIMARY KEY(project_id, host_id)
   ) STRICT;`,
  `ALTER TABLE cards ADD COLUMN github_repository TEXT;
   ALTER TABLE cards ADD COLUMN issue_url TEXT;
   ALTER TABLE cards ADD COLUMN issue_snapshot TEXT;
   ALTER TABLE cards ADD COLUMN review_ready INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE cards ADD COLUMN pr_url TEXT;
   ALTER TABLE cards ADD COLUMN github_state TEXT;
   ALTER TABLE cards ADD COLUMN retired INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE cards ADD COLUMN historical INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE cards ADD COLUMN lead_environment_id TEXT;
   ALTER TABLE cards ADD COLUMN import_branch TEXT;
   ALTER TABLE cards ADD COLUMN issue_refreshed INTEGER NOT NULL DEFAULT 0;
   CREATE UNIQUE INDEX cards_issue ON cards(project_id, host_id, lower(issue_url)) WHERE issue_url IS NOT NULL AND (historical = 0 OR github_repository IS NOT NULL);
   CREATE TABLE legacy_cards (card_id TEXT PRIMARY KEY REFERENCES cards(id), source_id TEXT NOT NULL UNIQUE, record TEXT NOT NULL, resume_target TEXT);
   CREATE TABLE review_records (card_id TEXT PRIMARY KEY REFERENCES cards(id), record TEXT NOT NULL, warnings TEXT NOT NULL);
   CREATE TABLE reviewer_models (id INTEGER PRIMARY KEY CHECK(id = 1), config TEXT NOT NULL);
   CREATE TABLE pipeline_settings (id INTEGER PRIMARY KEY CHECK(id = 1), lead_selection TEXT NOT NULL);
   CREATE TABLE imported_thread_links (card_id TEXT REFERENCES cards(id), thread_id TEXT NOT NULL,
     PRIMARY KEY(card_id, thread_id));`,
];

type Operation = "launch" | "pause" | "stop" | "resume";
export interface CardRow {
  id: string;
  project_id: string;
  host_id: string;
  title: string;
  body: string;
  base_ref: string;
  lead_execution: string | null;
  mode: PipelineCard["mode"];
  size: PipelineCard["size"];
  shape_review: number;
  column: PipelineCard["column"];
  run_state: PipelineCard["runState"];
  start_requested: number;
  lead_thread_id: string | null;
  attention_reason: string | null;
  result: string | null;
  launch_error: string | null;
  control_error: string | null;
  queued_at: number | null;
  occupies_slot: number;
  operation: Operation | null;
  operation_id: string | null;
  link_identity: string | null;
  revision: number;
  issue_url: string | null;
  github_repository: string | null;
  issue_snapshot: string | null;
  review_ready: number;
  pr_url: string | null;
  github_state: string | null;
  retired: number;
  historical: number;
  import_branch: string | null;
  lead_environment_id: string | null;
  issue_refreshed: number;
}

export interface CardHistory {
  id: number;
  cardId: string;
  at: number;
  kind: string;
  fromColumn: PipelineColumn | null;
  toColumn: PipelineColumn | null;
  source: string;
  threadId: string | null;
  note: string | null;
}

export const githubState = (row: CardRow): GithubSyncState | null =>
  row.github_state === null ? null : (JSON.parse(row.github_state) as GithubSyncState);
export const issueSnapshot = (row: CardRow): GithubIssueDetails | null =>
  row.issue_snapshot === null ? null : (JSON.parse(row.issue_snapshot) as GithubIssueDetails);

export interface ImportTarget {
  repository?: string | undefined;
  branch?: string | undefined;
  hostId?: string | undefined;
  projectId?: string | undefined;
}

type Snapshot = { snapshot: string; report_token: string; callback_origin: string };
type InternalPatch = Partial<
  Pick<
    CardRow,
    | "column"
    | "run_state"
    | "start_requested"
    | "lead_thread_id"
    | "lead_execution"
    | "attention_reason"
    | "result"
    | "launch_error"
    | "control_error"
    | "queued_at"
    | "occupies_slot"
    | "operation"
    | "operation_id"
    | "link_identity"
    | "review_ready"
    | "pr_url"
    | "github_state"
    | "retired"
    | "issue_snapshot"
    | "issue_refreshed"
    | "lead_environment_id"
    | "historical"
  >
>;

const fail = (message: string): never => {
  throw new PipelineFailure({ message });
};

function publicCard(row: CardRow, waitingReason: string | null, runNext: boolean): PipelineCard {
  const github = githubState(row);
  const status = github?.status;
  return {
    id: row.id,
    projectId: ProjectId.make(row.project_id),
    hostId: EnvironmentId.make(row.host_id),
    title: row.title,
    body: row.body,
    baseRef: row.base_ref,
    mode: row.mode,
    size: row.size,
    shapeReview: row.shape_review === 1,
    column: row.column,
    runState: row.run_state,
    startRequested: row.start_requested === 1,
    leadThreadId: row.lead_thread_id === null ? null : ThreadId.make(row.lead_thread_id),
    leadEnvironmentId:
      row.lead_environment_id === null ? null : EnvironmentId.make(row.lead_environment_id),
    historical: row.historical === 1,
    issueUrl: row.issue_url,
    pullRequest:
      status === undefined
        ? null
        : {
            url: status.url,
            state: status.state,
            draft: status.draft,
            headSha: status.headSha,
            checks: status.checks,
            review: status.review,
            batchId: status.batchId,
            error: status.error,
            pendingFeedback: status.manualReviewPending
              ? (github?.batch?.feedback ?? []).map(({ id, author, url }) => ({ id, author, url }))
              : [],
            ...(status.manualReviewPending === undefined
              ? {}
              : { manualReviewPending: status.manualReviewPending }),
          },
    worktreeRetired: row.retired === 1,
    attentionReason: row.attention_reason,
    result: row.result,
    launchError: row.launch_error,
    controlError: row.control_error,
    occupiesSlot: row.occupies_slot === 1,
    waitingReason,
    runNext,
    revision: row.revision,
  };
}

export function createCardStore(db: NodeSqlite.DatabaseSync, now = Date.now) {
  function transaction<T>(work: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS pipeline_migrations (version INTEGER PRIMARY KEY) STRICT;`);
  transaction(() => {
    const recorded = db.prepare("SELECT version FROM pipeline_migrations ORDER BY version").all();
    if (
      recorded.length > migrations.length ||
      recorded.some((row, index) => row.version !== index + 1)
    ) {
      throw new Error("Invalid Pipeline migration ledger.");
    }
    for (const [index, migration] of migrations.entries()) {
      if (index < recorded.length) continue;
      db.exec(migration);
      db.prepare("INSERT INTO pipeline_migrations VALUES (?)").run(index + 1);
    }
  });

  const get = (id: string) =>
    (db.prepare("SELECT * FROM cards WHERE id = ?").get(id) as unknown as CardRow | undefined) ??
    null;
  const required = (id: string) => get(id) ?? fail("Card not found.");
  const addHistory = (
    card: CardRow,
    kind: string,
    source: string,
    before?: CardRow,
    note?: string,
  ) =>
    db
      .prepare(`INSERT INTO card_history (card_id, at, kind, source, from_column, to_column, thread_id, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        card.id,
        now(),
        kind,
        source,
        before?.column ?? null,
        card.column,
        card.lead_thread_id,
        note ?? card.attention_reason ?? card.launch_error ?? card.control_error,
      );

  function update(
    card: CardRow,
    patch: InternalPatch,
    kind?: string,
    source = "system",
    note?: string,
  ) {
    const next = { ...card, ...patch };
    db.prepare(`UPDATE cards SET
      "column" = ?, run_state = ?, start_requested = ?, lead_thread_id = ?, lead_execution = ?, attention_reason = ?,
      result = ?, launch_error = ?, control_error = ?, queued_at = ?, occupies_slot = ?,
      operation = ?, operation_id = ?, link_identity = ?, review_ready = ?, pr_url = ?, github_state = ?,
      retired = ?, issue_snapshot = ?, issue_refreshed = ?, lead_environment_id = ?, historical = ?, updated_at = ?, revision = revision + 1
      WHERE id = ?`).run(
      next.column,
      next.run_state,
      next.start_requested,
      next.lead_thread_id,
      next.lead_execution,
      next.attention_reason,
      next.result,
      next.launch_error,
      next.control_error,
      next.queued_at,
      next.occupies_slot,
      next.operation,
      next.operation_id,
      next.link_identity,
      next.review_ready,
      next.pr_url,
      next.github_state,
      next.retired,
      next.issue_snapshot,
      next.issue_refreshed,
      next.lead_environment_id,
      next.historical,
      now(),
      next.id,
    );
    if (next.run_state !== "running" || next.column === "done" || next.occupies_slot === 1) {
      db.prepare("DELETE FROM run_next WHERE card_id = ?").run(next.id);
    }
    if (kind) addHistory(next, kind, source, card, note);
  }

  const limitFor = (card: CardRow) =>
    Number(
      db
        .prepare("SELECT task_limit FROM task_limits WHERE project_id = ? AND host_id = ?")
        .get(card.project_id, card.host_id)?.task_limit ?? PIPELINE_DEFAULT_LIMIT,
    );
  const occupied = (card: CardRow) =>
    Number(
      db
        .prepare(
          "SELECT count(*) AS count FROM cards WHERE project_id = ? AND host_id = ? AND occupies_slot = 1",
        )
        .get(card.project_id, card.host_id)?.count,
    );
  const snapshot = (id: string) =>
    db
      .prepare("SELECT * FROM instruction_snapshots WHERE card_id = ?")
      .get(id) as unknown as Snapshot;
  function pinInstructions(id: string, instructions: string, origin: string) {
    db.prepare("INSERT OR IGNORE INTO instruction_snapshots VALUES (?, ?, ?, ?)").run(
      id,
      instructions,
      NodeCrypto.randomBytes(32).toString("base64url"),
      origin,
    );
  }
  function queue(card: CardRow, kind: "start_requested" | "retry_requested" | "resume_requested") {
    const operation = card.lead_thread_id === null ? "launch" : "resume";
    update(
      card,
      {
        column: card.start_requested ? card.column : "todo",
        start_requested: 1,
        run_state: "running",
        queued_at: now(),
        operation,
        operation_id: operation === "launch" ? card.id : NodeCrypto.randomUUID(),
        launch_error: null,
        control_error: null,
      },
      kind,
      "user",
    );
  }

  function create(
    input: PipelineNewCard,
    instructions: string,
    origin: string,
    issue: GithubIssueDetails | null,
    repository: string | null,
  ) {
    if (issue !== null) {
      const existing = db
        .prepare(
          `SELECT id FROM cards WHERE project_id = ? AND host_id = ? AND lower(issue_url) = lower(?) AND (historical = 0 OR github_repository IS NOT NULL)`,
        )
        .get(input.projectId, input.hostId, issue.url);
      if (existing) return String(existing.id);
    }
    const id = NodeCrypto.randomUUID();
    const at = now();
    db.prepare(`INSERT INTO cards (id, project_id, host_id, title, body, base_ref, lead_execution,
      mode, size, shape_review, "column", run_state, start_requested, created_at, updated_at, issue_url, issue_snapshot, github_repository)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'backlog', 'running', 0, ?, ?, ?, ?, ?)`).run(
      id,
      input.projectId,
      input.hostId,
      input.title,
      input.body,
      input.baseRef,
      input.lead ? JSON.stringify(input.lead) : null,
      input.mode,
      input.size,
      input.shapeReview ? 1 : 0,
      at,
      at,
      issue?.url ?? null,
      issue === null ? null : JSON.stringify(issue),
      repository,
    );
    const card = required(id);
    addHistory(card, "created", "user");
    if (input.start) {
      pinInstructions(id, instructions, origin);
      queue(card, "start_requested");
    }
    return id;
  }

  function requestControl(card: CardRow, kind: "pause" | "stop") {
    if (!card.start_requested || card.column === "done")
      fail("Only an open, started card can be held.");
    if (
      card.run_state === "paused" ||
      card.run_state === "stopping" ||
      (kind === "pause" && card.run_state !== "running")
    )
      return;
    if (!card.occupies_slot) {
      update(
        card,
        {
          run_state: "paused",
          operation: null,
          operation_id: null,
          queued_at: null,
          control_error: null,
        },
        "paused",
        "user",
      );
      return;
    }
    const held = {
      run_state: kind === "pause" ? "pause_requested" : "stopping",
      control_error: null,
    } as const;
    // A launch that may have reached the peer must be reconciled before controlling its lead.
    update(
      card,
      card.operation === "launch" || card.operation === "resume"
        ? held
        : {
            ...held,
            operation: kind,
            operation_id: NodeCrypto.randomUUID(),
          },
      kind === "pause" ? "pause_requested" : "stop_requested",
      "user",
    );
  }

  return {
    get,
    snapshot,
    leadDefault() {
      const row = db.prepare("SELECT lead_selection FROM pipeline_settings WHERE id = 1").get();
      return typeof row?.lead_selection === "string" ? row.lead_selection : null;
    },
    cards() {
      const rows = db
        .prepare("SELECT * FROM cards ORDER BY updated_at DESC, id")
        .all() as unknown as CardRow[];
      const preferred = new Set(
        db
          .prepare("SELECT card_id FROM run_next")
          .all()
          .map((row) => row.card_id),
      );
      return rows.map((card) => {
        let waiting: string | null = null;
        if (card.queued_at !== null && card.run_state === "running") {
          const limit = limitFor(card);
          waiting =
            occupied(card) >= limit
              ? `Waiting for capacity (${limit} concurrent tasks)`
              : "Waiting to start";
        }
        return publicCard(card, waiting, preferred.has(card.id));
      });
    },
    limits() {
      return db
        .prepare("SELECT * FROM task_limits")
        .all()
        .map((row) => ({
          projectId: ProjectId.make(String(row.project_id)),
          hostId: EnvironmentId.make(String(row.host_id)),
          limit: Number(row.task_limit),
        }));
    },
    importTarget(id: string): ImportTarget {
      const row = db.prepare("SELECT resume_target FROM legacy_cards WHERE card_id = ?").get(id);
      return typeof row?.resume_target === "string"
        ? (JSON.parse(row.resume_target) as ImportTarget)
        : {};
    },
    resumeImported(
      id: string,
      target: {
        hostId: EnvironmentId;
        projectId: ProjectId;
        repository: string;
        branch: string | null;
      },
      instructions: string,
      origin: string,
    ) {
      return transaction(() => {
        const card = required(id);
        if (!card.historical || card.column === "done")
          fail("Only an active imported card can resume.");
        if (card.operation !== null) return id;
        const duplicate =
          card.issue_url &&
          db
            .prepare(`SELECT 1 FROM cards
          WHERE id <> ? AND project_id = ? AND host_id = ? AND lower(issue_url) = lower(?)`)
            .get(id, target.projectId, target.hostId, card.issue_url);
        if (duplicate) fail("This issue already has a card on the destination checkout.");
        if (card.lead_thread_id) addHistory(card, "imported_lead", "migration");
        pinInstructions(id, instructions, origin);
        db.prepare("UPDATE instruction_snapshots SET callback_origin = ? WHERE card_id = ?").run(
          origin,
          id,
        );
        db.prepare(`UPDATE cards SET host_id = ?, project_id = ?, github_repository = ?, base_ref = ?,
          import_branch = ?, link_identity = NULL, lead_thread_id = NULL, lead_environment_id = NULL
          WHERE id = ?`).run(
          target.hostId,
          target.projectId,
          target.repository,
          target.branch === null ? "HEAD" : `origin/${target.branch}`,
          target.branch,
          id,
        );
        queue(required(id), "resume_requested");
        return id;
      });
    },
    mutate(
      action: PipelineMutation,
      instructions: string,
      origin: string,
      issue: GithubIssueDetails | null = null,
      repository: string | null = null,
    ) {
      return transaction(() => {
        if (action.kind === "create")
          return create(action.card, instructions, origin, issue, repository);
        if (action.kind === "limit") {
          db.prepare(`INSERT INTO task_limits VALUES (?, ?, ?)
            ON CONFLICT (project_id, host_id) DO UPDATE SET task_limit = excluded.task_limit`).run(
            action.projectId,
            action.hostId,
            action.limit,
          );
          return null;
        }
        const card = required(action.id);
        if (card.historical) fail("Imported cards are held.");
        switch (action.kind) {
          case "send_review": {
            const state = githubState(card);
            if (!state?.batch || state.batch.state !== "pending")
              fail("There is no pending review batch.");
            state!.batch!.manualDispatch = true;
            state!.status.manualReviewPending = false;
            update(card, { github_state: JSON.stringify(state) });
            break;
          }
          case "refresh_github":
            break;
          case "start":
            if (card.start_requested) break;
            pinInstructions(card.id, instructions, origin);
            queue(card, "start_requested");
            break;
          case "retry":
            if (card.run_state !== "running" || card.launch_error === null)
              fail("There is no failed launch to retry.");
            queue(card, "retry_requested");
            break;
          case "pause":
          case "stop":
            requestControl(card, action.kind);
            break;
          case "resume":
            if (card.run_state !== "paused") fail("Wait for the card to pause before resuming it.");
            queue(card, "resume_requested");
            break;
          case "move":
            if (!card.start_requested && action.column === "todo") {
              pinInstructions(card.id, instructions, origin);
              queue(card, "start_requested");
            } else {
              if (
                !card.start_requested ||
                action.column === "backlog" ||
                card.run_state !== "running" ||
                card.lead_thread_id === null
              )
                fail("Start or resume the card before moving it.");
              if (card.column === "done" && action.column !== "done" && !card.occupies_slot) {
                fail("A completed card has released its slot.");
              }
              update(card, { column: action.column }, "moved", "user");
            }
            break;
          case "run_next":
            if (card.queued_at === null || card.occupies_slot)
              fail("Only queued cards can run next.");
            db.prepare(`INSERT INTO run_next VALUES (?, ?, ?)
              ON CONFLICT (project_id, host_id) DO UPDATE SET card_id = excluded.card_id`).run(
              card.project_id,
              card.host_id,
              card.id,
            );
            break;
          case "clear_run_next":
            db.prepare("DELETE FROM run_next WHERE card_id = ?").run(card.id);
            break;
        }
        return card.id;
      });
    },
    authorize(id: string, token: string) {
      if (!/^[\w-]{43}$/.test(token)) return false;
      const saved = snapshot(id);
      return (
        saved !== undefined &&
        NodeCrypto.timingSafeEqual(Buffer.from(token), Buffer.from(saved.report_token))
      );
    },
    report(id: string, report: PipelineReport) {
      transaction(() => {
        const card = required(id);
        if (card.historical) fail("Imported cards are held.");
        if (report.kind === "pull_request") {
          const url = normalizePullRequestUrl(report.url);
          if (
            url === null ||
            !card.github_repository ||
            !url
              .toLowerCase()
              .startsWith(`https://github.com/${card.github_repository.toLowerCase()}/pull/`)
          ) {
            fail("The PR must belong to this card’s GitHub repository.");
          }
          if (!card.occupies_slot || card.run_state !== "running" || card.column === "done")
            fail("The card is held.");
          if (card.pr_url !== url)
            update(
              card,
              { pr_url: url, github_state: null, review_ready: 0, column: "pr" },
              "pr_linked",
              "lead",
              url ?? undefined,
            );
          return;
        }
        if (report.kind === "review_wait") {
          if (!card.pr_url || card.run_state !== "running" || card.column === "done")
            fail("Link the PR before handing off review.");
          const state = githubState(card);
          if (report.handled && state?.batch?.id !== report.handled)
            fail("This review batch is no longer current.");
          if (report.handled && state?.batch) {
            if (state.batch.state === "handled") return;
            if (state.batch.state !== "sending" && state.batch.state !== "delivered")
              fail("This review batch has not been delivered.");
            if (state.batch.state === "sending")
              addHistory(card, "review_delivered", "github", card, state.batch.id);
            state.batch.state = "handled";
            state.status.followup = "handled";
            state.status.review =
              state.batch.headSha === state.status.headSha ? "clear" : "waiting";
          }
          update(
            card,
            {
              review_ready: 1,
              attention_reason: null,
              github_state: state === null ? null : JSON.stringify(state),
            },
            report.handled ? "review_handled" : "review_waiting",
            "lead",
            report.handled,
          );
          return;
        }
        if (report.kind === "paused") {
          if (
            card.operation_id !== report.requestId ||
            !["pause_requested", "pausing", "paused"].includes(card.run_state)
          ) {
            fail("This pause request is no longer current.");
          }
          if (card.run_state === "pause_requested") {
            update(
              card,
              { run_state: "pausing", control_error: null },
              "pause_acknowledged",
              "lead",
            );
          }
          return;
        }
        if (!card.occupies_slot || card.run_state !== "running" || card.column === "done") {
          if (
            card.column === "done" &&
            report.column === "done" &&
            (report.result === undefined || report.result === card.result)
          )
            return;
          fail("The card is held or its slot has been released.");
        }
        update(
          card,
          {
            ...(report.column === undefined ? {} : { column: report.column }),
            ...(report.needsYou === undefined ? {} : { attention_reason: report.needsYou }),
            ...(report.result === undefined ? {} : { result: report.result }),
          },
          report.needsYou === undefined ? "report" : "attention",
          "lead",
          report.needsYou === undefined ? undefined : (report.needsYou ?? "cleared"),
        );
      });
    },
    githubCards() {
      return db
        .prepare(`SELECT * FROM cards WHERE pr_url IS NOT NULL AND historical = 0
        AND (retired = 0 OR "column" <> 'done') ORDER BY updated_at`)
        .all() as unknown as CardRow[];
    },
    updateGithub(
      id: string,
      url: string,
      patch: (card: CardRow) => InternalPatch | undefined,
      kind?: string,
      note?: string,
    ) {
      return transaction(() => {
        const card = required(id);
        if (card.pr_url !== url || card.historical) return false;
        const changes = patch(card);
        if (changes === undefined) return false;
        update(card, changes, kind, "github", note);
        return true;
      });
    },
    history(projectId: ProjectId, hostId: EnvironmentId) {
      return db
        .prepare(`SELECT h.id, h.card_id AS cardId, h.at, h.kind, h.source, h.from_column AS fromColumn,
        h.to_column AS toColumn, h.thread_id AS threadId, h.note FROM card_history h
        JOIN cards c ON c.id = h.card_id WHERE c.project_id = ? AND c.host_id = ? ORDER BY h.at, h.id`)
        .all(projectId, hostId) as unknown as CardHistory[];
    },
    claim() {
      return transaction(() => {
        const queued = db
          .prepare(`SELECT c.* FROM cards c LEFT JOIN run_next n ON n.card_id = c.id
          WHERE c.queued_at IS NOT NULL AND c.run_state = 'running' AND c.occupies_slot = 0
          ORDER BY n.card_id IS NULL, c.queued_at, c.rowid`)
          .all() as unknown as CardRow[];
        for (const card of queued) {
          if (occupied(card) < limitFor(card)) {
            update(card, { occupies_slot: 1, queued_at: null }, "admitted");
          }
        }
      });
    },
    pending() {
      return db
        .prepare(`SELECT * FROM cards WHERE occupies_slot = 1
        AND (operation IS NOT NULL OR run_state <> 'running' OR "column" = 'done')`)
        .all() as unknown as CardRow[];
    },
    apply(id: string, patch: (current: CardRow) => InternalPatch | undefined, kind?: string) {
      transaction(() => {
        const current = required(id);
        const changes = patch(current);
        if (
          changes !== undefined &&
          Object.entries(changes).some(
            ([key, value]) => current[key as keyof InternalPatch] !== value,
          )
        )
          update(current, changes, kind);
      });
    },
  };
}
