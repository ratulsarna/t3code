// @effect-diagnostics nodeBuiltinImport:off -- Use the same SQLite file across store restarts.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, test } from "vite-plus/test";

import { createCardStore } from "./store.ts";

const hostId = EnvironmentId.make("worker");
const projectId = ProjectId.make("checkout");
const origin = "http://localhost:4000";

const create = (store: ReturnType<typeof createCardStore>, title: string) =>
  store.mutate(
    {
      kind: "create",
      card: {
        title,
        hostId,
        projectId,
        body: "",
        baseRef: "main",
        start: true,
        mode: "manual",
        size: "standard",
        shapeReview: true,
      },
    },
    "Pinned lead instructions",
    origin,
  )!;

test("a crash keeps an ambiguous launch counted and admits the preferred card only after release", () => {
  const directory = mkdtempSync(join(tmpdir(), "t3-pipeline-"));
  try {
    const filename = join(directory, "pipeline.sqlite");
    let first: string;
    let preferred: string;
    let waiting: string;
    {
      using db = new DatabaseSync(filename);
      const store = createCardStore(db, () => 10);
      store.mutate({ kind: "limit", hostId, projectId, limit: 1 }, "", origin);
      first = create(store, "First");
      waiting = create(store, "Waiting");
      preferred = create(store, "Run next");
      store.claim();
      store.mutate({ kind: "run_next", id: preferred }, "", origin);
      store.mutate({ kind: "stop", id: first }, "", origin);
    }
    using db = new DatabaseSync(filename);
    const store = createCardStore(db);
    store.claim();
    expect(
      store.pending().map((card) => [card.id, card.operation, card.operation_id, card.run_state]),
    ).toEqual([[first, "launch", first, "stopping"]]);
    expect(store.cards().find(({ id }) => id === waiting)?.waitingReason).toContain("capacity");
    expect(store.cards().find(({ id }) => id === preferred)?.runNext).toBe(true);
    expect(store.snapshot(first).snapshot).toBe("Pinned lead instructions");

    store.apply(first, () => ({ operation: null, run_state: "paused", occupies_slot: 0 }));
    store.claim();
    expect(store.pending().map(({ id }) => id)).toEqual([preferred]);
    expect(store.cards().find(({ id }) => id === waiting)?.waitingReason).toContain("capacity");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a card token cannot authorize another card or acknowledge an obsolete pause", () => {
  using db = new DatabaseSync(":memory:");
  const store = createCardStore(db);
  const first = create(store, "First");
  const second = create(store, "Second");
  store.claim();
  store.apply(first, () => ({ lead_thread_id: "lead", operation: null, operation_id: null }));
  store.mutate({ kind: "pause", id: first }, "", origin);
  const requestId = store.get(first)!.operation_id!;
  expect(store.authorize(second, store.snapshot(first).report_token)).toBe(false);
  expect(() => store.report(first, { kind: "paused", requestId: second })).toThrow(
    "This pause request is no longer current.",
  );
  expect(store.get(first)?.run_state).toBe("pause_requested");
  store.report(first, { kind: "paused", requestId });
  expect(store.get(first)?.run_state).toBe("pausing");
  expect(store.get(first)?.occupies_slot).toBe(1);
  expect(() => store.report(first, { kind: "status", column: "done" })).toThrow("held");
});
