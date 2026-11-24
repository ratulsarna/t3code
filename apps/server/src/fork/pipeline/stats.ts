import {
  PIPELINE_COLUMNS,
  type PipelineColumn as Column,
  type PipelineStats as ProjectStats,
} from "@t3tools/contracts";
import type { CardHistory } from "./store.ts";

const STAT_COLUMNS = PIPELINE_COLUMNS.filter((column) => column !== "backlog" && column !== "done");
type StatsCard = { id: string; title: string; column: Column; leadThreadId: string | null };
/** Once a draft PR is up, time nobody stopped for the user is time with external review and the merge. */
const OUT_FOR_REVIEW = new Set<Column>(["pr", "pr_ready"]);

const CLEARS = new Set(["working", "cleared"]);
/** Rows that clear a wait besides an attention clear: a start, a launch, or a handoff to review. Moves do not. */
const CLEARING_KINDS = new Set(["launched", "start_requested", "review_waiting", "review_handled"]);
const endsWait = (row: CardHistory) =>
  (row.kind === "attention" && row.note !== null && CLEARS.has(row.note)) ||
  CLEARING_KINDS.has(row.kind);
const FAILURE_REASONS: Record<string, string> = {
  thread_failed: "Lead failed",
  thread_gone: "Lead archived or deleted",
  launch_failed: "Launch failed",
};
/** Moves that send work back to Implementing. External review sends it back as a handled feedback batch. */
const BOUNCES: Record<string, "review" | "qa"> = {
  "reviewing>implementing": "review",
  "qa>implementing": "qa",
};

/** Why a row stops the task for the user, or null when it does not. */
function waitReason(row: CardHistory): string | null {
  if (row.kind in FAILURE_REASONS) return FAILURE_REASONS[row.kind]!;
  if (row.kind !== "attention" || row.note === null || CLEARS.has(row.note)) return null;
  // Jev's verdict on a lead that went idle without a report.
  if (row.note === "needs user") return "Stopped without a report";
  // Leads write free text: keep the head before any detail, and drop step counters.
  const reason = row.note
    .split(";")[0]!
    .replace(/\bstep \d+ of \d+\b/gi, "")
    .replace(/[\s:,.-]+$/, "")
    .trim();
  return reason === "" ? "Needs you" : reason.charAt(0).toUpperCase() + reason.slice(1);
}

/** Rows that only note something about another thread, and say nothing about this task. */
const ignored = (row: CardHistory) =>
  row.kind === "attention" && row.note?.startsWith("ignored") === true;

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/** Time spent in one stay in a stage, kept apart until the task leaves it. */
type Visit = {
  workingMs: number;
  waitingMs: number;
  reviewMs: number;
  pausedMs: number;
  waits: Map<string, number>;
};
const visit = (): Visit => ({
  workingMs: 0,
  waitingMs: 0,
  reviewMs: 0,
  pausedMs: 0,
  waits: new Map(),
});

// Only completed stays count toward durations. Questions and approvals only count as stops.
export function projectStats(
  cards: ReadonlyArray<StatsCard>,
  history: ReadonlyArray<CardHistory>,
  { from, now }: { from: number; now: number },
): ProjectStats {
  type Stage = {
    -readonly [K in keyof ProjectStats["stages"][number]]: ProjectStats["stages"][number][K];
  };
  const stages = new Map<Column, Stage>(
    STAT_COLUMNS.map((column) => [
      column,
      { column, workingMs: 0, waitingMs: 0, reviewMs: 0, pausedMs: 0 },
    ]),
  );
  const reasons = new Map<string, { reason: string; count: number; waitingMs: number }>();
  const reasonFor = (reason: string) => {
    let entry = reasons.get(reason);
    if (entry === undefined) reasons.set(reason, (entry = { reason, count: 0, waitingMs: 0 }));
    return entry;
  };
  const byCard = new Map<string, CardHistory[]>();
  for (const row of history) {
    const rows = byCard.get(row.cardId);
    if (rows === undefined) byCard.set(row.cardId, [row]);
    else rows.push(row);
  }
  const inRange = (at: number) => at >= from && at <= now;
  const overlap = (start: number, end: number) =>
    Math.max(0, Math.min(end, now) - Math.max(start, from));
  const durations: number[] = [];
  const top: Array<ProjectStats["bounces"]["top"][number]> = [];
  let finished = 0;
  let review = 0;
  let qa = 0;
  let external = 0;
  let reviewed = 0;

  for (const card of cards) {
    const rows = (byCard.get(card.id) ?? [])
      .filter((row) => !ignored(row))
      .sort((a, b) => a.at - b.at || a.id - b.id);
    let column: Column | null = null;
    let stay = visit();
    // Independent: a pause neither ends nor starts a wait on the user.
    let paused = false;
    let waiting = false;
    let reason: string | null = null;
    let since = 0;
    let started: number | null = null;
    let done: number | null = null;
    const bounced = { review: 0, qa: 0, external: 0 };
    let inReview = false;
    const batches = new Set<string | null>();
    const leave = () => {
      const stage = column === null ? undefined : stages.get(column);
      if (stage === undefined) return;
      stage.workingMs += stay.workingMs;
      stage.waitingMs += stay.waitingMs;
      stage.reviewMs += stay.reviewMs;
      stage.pausedMs += stay.pausedMs;
      for (const [why, ms] of stay.waits) reasonFor(why).waitingMs += ms;
    };
    for (const row of rows) {
      const spent = overlap(since, row.at);
      if (spent > 0 && column === "reviewing") inReview = true;
      if (spent > 0) {
        if (paused) stay.pausedMs += spent;
        else if (!waiting && OUT_FOR_REVIEW.has(column!)) stay.reviewMs += spent;
        else if (!waiting) stay.workingMs += spent;
        else {
          stay.waitingMs += spent;
          stay.waits.set(reason!, (stay.waits.get(reason!) ?? 0) + spent);
        }
      }
      since = row.at;

      if (row.toColumn !== null && row.toColumn !== column) {
        if (inRange(row.at)) {
          const bounce = BOUNCES[`${column}>${row.toColumn}`];
          if (bounce !== undefined) bounced[bounce] += 1;
          if (row.toColumn === "reviewing") inReview = true;
        }
        if (row.toColumn === "planning") started ??= row.at;
        // A reopened task is not finished until it reaches Done again, and then finishes there.
        done = row.toColumn === "done" ? row.at : null;
        leave();
        column = row.toColumn;
        stay = visit();
      }
      // A handled batch is one round however many times its handoff is retried, in this range or before.
      if (row.kind === "review_handled" && !batches.has(row.note)) {
        batches.add(row.note);
        if (inRange(row.at)) bounced.external += 1;
      }
      if (inRange(row.at) && (row.kind === "review_waiting" || row.kind === "review_handled"))
        inReview = true;
      if (inRange(row.at) && row.kind === "question" && column !== "done" && row.note !== null)
        reasonFor(row.note).count += 1;

      if (row.kind === "paused") paused = true;
      if (row.kind === "resumed") paused = false;
      // Done is past every stop: archiving a finished task's lead is cleanup.
      const why = column === "done" ? null : waitReason(row);
      if (why !== null) {
        // A stop reported or observed again before anything cleared it is the same stop.
        const same = waiting && reason === why;
        if (inRange(row.at) && !same) reasonFor(why).count += 1;
        reason = why;
        waiting = true;
      } else if (endsWait(row)) waiting = false;
    }
    if (column === "reviewing" && overlap(since, now) > 0) inReview = true;
    if (done !== null && inRange(done)) {
      finished += 1;
      if (started !== null && started <= done) durations.push(done - started);
    }
    const bounces = bounced.review + bounced.qa + bounced.external;
    review += bounced.review;
    qa += bounced.qa;
    external += bounced.external;
    if (inReview || bounces > 0) reviewed += 1;
    if (bounces > 0)
      top.push({ cardId: card.id, title: card.title, leadThreadId: card.leadThreadId, ...bounced });
  }

  return {
    finished,
    startToDoneMs: median(durations),
    inProgress: cards.filter((card) => card.column !== "backlog" && card.column !== "done").length,
    stages: [...stages.values()],
    bounces: {
      review,
      qa,
      external,
      perCard: reviewed === 0 ? null : (review + qa + external) / reviewed,
      top: top
        .sort(
          (a, b) =>
            b.review + b.qa + b.external - (a.review + a.qa + a.external) || b.review - a.review,
        )
        .slice(0, 5),
    },
    reasons: [...reasons.values()]
      .filter((entry) => entry.count > 0 || entry.waitingMs > 0)
      .sort((a, b) => b.count - a.count || b.waitingMs - a.waitingMs)
      .slice(0, 8),
  };
}
