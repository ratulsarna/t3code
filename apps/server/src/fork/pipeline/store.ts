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
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";

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
];

type Operation = "launch" | "pause" | "stop" | "resume";
interface CardRow {
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
}
type Snapshot = { snapshot: string; report_token: string; callback_origin: string };
type InternalPatch = Partial<
  Pick<
    CardRow,
    | "column"
    | "run_state"
    | "start_requested"
    | "lead_thread_id"
    | "attention_reason"
    | "result"
    | "launch_error"
    | "control_error"
    | "queued_at"
    | "occupies_slot"
    | "operation"
    | "operation_id"
    | "link_identity"
  >
>;

const fail = (message: string): never => {
  throw new PipelineFailure({ message });
};

function publicCard(row: CardRow, waitingReason: string | null, runNext: boolean): PipelineCard {
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
  const addHistory = (card: CardRow, kind: string, source: string, before?: CardRow) =>
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
        card.attention_reason ?? card.launch_error ?? card.control_error,
      );

  function update(card: CardRow, patch: InternalPatch, kind?: string, source = "system") {
    const next = { ...card, ...patch };
    db.prepare(`UPDATE cards SET
      "column" = ?, run_state = ?, start_requested = ?, lead_thread_id = ?, attention_reason = ?,
      result = ?, launch_error = ?, control_error = ?, queued_at = ?, occupies_slot = ?,
      operation = ?, operation_id = ?, link_identity = ?, updated_at = ?, revision = revision + 1
      WHERE id = ?`).run(
      next.column,
      next.run_state,
      next.start_requested,
      next.lead_thread_id,
      next.attention_reason,
      next.result,
      next.launch_error,
      next.control_error,
      next.queued_at,
      next.occupies_slot,
      next.operation,
      next.operation_id,
      next.link_identity,
      now(),
      next.id,
    );
    if (next.run_state !== "running" || next.column === "done" || next.occupies_slot === 1) {
      db.prepare("DELETE FROM run_next WHERE card_id = ?").run(next.id);
    }
    if (kind) addHistory(next, kind, source, card);
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

  function create(input: PipelineNewCard, instructions: string, origin: string) {
    const id = NodeCrypto.randomUUID();
    const at = now();
    db.prepare(`INSERT INTO cards (id, project_id, host_id, title, body, base_ref, lead_execution,
      mode, size, shape_review, "column", run_state, start_requested, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'backlog', 'running', 0, ?, ?)`).run(
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
    mutate(action: PipelineMutation, instructions: string, origin: string) {
      return transaction(() => {
        if (action.kind === "create") return create(action.card, instructions, origin);
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
        switch (action.kind) {
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
          "report",
          "lead",
        );
      });
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
