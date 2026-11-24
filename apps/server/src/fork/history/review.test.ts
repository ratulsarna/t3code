import * as NodePath from "node:path";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../config.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { normalizeAttachmentReferences } from "./attachmentReferences.ts";
import { bbThreadId, eventsForThread } from "./events.ts";
import { importHistory } from "./import.ts";
import type { HistoryRecord, Row } from "./records.ts";

const defaultRecord = (id: string): HistoryRecord => ({
  thread: {
    id,
    project_id: id,
    project_name: "History fixture",
    project_remote: null,
    project_sort_key: "",
    provider_id: "codex",
    model: null,
    title: "Imported thread",
    title_fallback: null,
    status: "idle",
    visibility: "visible",
    section_id: null,
    created_at: 1000,
    updated_at: 2000,
    archived_at: null,
    pinned_at: null,
    pin_sort_key: null,
    last_read_at: null,
    source_thread_id: null,
    parent_thread_id: null,
    lifecycle_owner_thread_id: null,
    environment_id: null,
    path: null,
    branch_name: null,
    host_id: null,
    host_name: null,
  },
  links: { children: [], importedChildren: [], forkParent: null, forkRoot: id },
  attachments: [],
  items: [],
});

const messageWithFile = (path: string): Row => ({
  kind: "conversation",
  nested: false,
  role: "user",
  text: "Read the attached memo",
  createdAt: 1000,
  startedAt: 1000,
  turnRequest: { status: "accepted" },
  attachments: { localImagePaths: [], localFilePaths: [path], imageUrls: [] },
});

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig.ServerConfig;
  const spool = NodePath.join(config.baseDir, "history.jsonl");
  const mapping = NodePath.join(config.baseDir, "workspace-map.json");
  const uploads = NodePath.join(config.baseDir, "source-uploads");
  const write = (record: HistoryRecord) => fs.writeFileString(spool, JSON.stringify(record) + "\n");
  const run = (workspaceMapFile?: string) =>
    Effect.scoped(importHistory({ file: spool, attachmentRoot: uploads, workspaceMapFile }));
  const projectionLayer = ProjectionStore.layer.pipe(Layer.provide(SqlitePersistence.layerConfig));
  const find = (id: string) =>
    ProjectionStore.ProjectionStoreV2.use((store) => store.findThread(bbThreadId(id))).pipe(
      Effect.provide(projectionLayer),
    );
  const messages = (id: string) =>
    ProjectionStore.ProjectionStoreV2.use((store) =>
      store.getThreadRecords(bbThreadId(id), ["messages"]),
    ).pipe(Effect.provide(projectionLayer));
  return { fs, config, mapping, uploads, write, run, find, messages };
});

const testServices = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
const layerTest = ServerConfig.layerTest(".", { prefix: "bb-history-review" }).pipe(
  Layer.provideMerge(testServices),
);

it.effect("an absent attachment store leaves the thread available for a corrected retry", () =>
  Effect.gen(function* () {
    const { fs, uploads, write, run, find, messages } = yield* fixture;
    const record = defaultRecord("attachment-retry");
    yield* write({
      ...record,
      attachments: [
        {
          project_id: record.thread.project_id,
          stored_path: "memo.pdf",
          original_name: "memo.pdf",
          mime_type: "application/pdf",
          size_bytes: 3,
        },
        {
          project_id: record.thread.project_id,
          stored_path: "missing.pdf",
          original_name: "missing.pdf",
          mime_type: "application/pdf",
          size_bytes: 3,
        },
      ],
      items: [messageWithFile("memo.pdf"), messageWithFile("missing.pdf")],
    });
    assert.isTrue(Exit.isFailure(yield* Effect.exit(run())));
    assert.isNull(yield* find(record.thread.id));

    yield* fs.makeDirectory(uploads);
    assert.isTrue(Exit.isFailure(yield* Effect.exit(run())));
    assert.isNull(yield* find(record.thread.id));

    const projectUploads = NodePath.join(uploads, record.thread.project_id);
    yield* fs.makeDirectory(projectUploads);
    yield* fs.writeFileString(NodePath.join(projectUploads, "memo.pdf"), "abc");
    yield* run();
    const imported = yield* messages(record.thread.id);
    assert.deepEqual(
      imported.messages.map((message) => message.attachments.map((attachment) => attachment.name)),
      [["memo.pdf"], []],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a corrected workspace mapping can retry after a persisted project rejection", () =>
  Effect.gen(function* () {
    const { fs, config, mapping, uploads, write, run, find } = yield* fixture;
    yield* fs.makeDirectory(uploads);
    const occupied = NodePath.join(config.baseDir, "occupied");
    const corrected = NodePath.join(config.baseDir, "corrected");
    yield* fs.makeDirectory(occupied);
    yield* fs.makeDirectory(corrected);

    yield* write(defaultRecord("existing-project"));
    yield* fs.writeFileString(mapping, JSON.stringify({ "existing-project": occupied }));
    yield* run(mapping);

    const record = defaultRecord("corrected-project");
    yield* write(record);
    yield* fs.writeFileString(mapping, JSON.stringify({ "corrected-project": occupied }));
    assert.isTrue(Exit.isFailure(yield* Effect.exit(run(mapping))));
    assert.isNull(yield* find(record.thread.id));

    yield* fs.writeFileString(mapping, JSON.stringify({ "corrected-project": corrected }));
    yield* run(mapping);
    assert.isNotNull(yield* find(record.thread.id));
  }).pipe(Effect.provide(layerTest)),
);

it("matches the canonical upload inventory while keeping an executor-local attachment reference", () => {
  const executorPath = "/workspace/local-memo.pdf";
  const row = messageWithFile("./memo.pdf");
  assert(row.kind === "conversation" && row.attachments !== null);
  const normalized = normalizeAttachmentReferences(
    {
      ...row,
      attachments: { ...row.attachments, localFilePaths: ["./memo.pdf", executorPath] },
    },
    (path) => (path === "./memo.pdf" ? ["memo.pdf"] : []),
    new Set(["memo.pdf"]),
  );
  const events = eventsForThread(
    { ...defaultRecord("alias"), items: [normalized] },
    new Map([
      [
        "memo.pdf",
        {
          id: "test-memo",
          type: "file",
          name: "memo.pdf",
          mimeType: "application/pdf",
          sizeBytes: 3,
        },
      ],
    ]),
    new Map(),
    [],
  );
  const message = events.find((event) => event.type === "message.updated");
  assert.deepEqual(
    message?.payload.attachments.map((attachment) => attachment.name),
    ["memo.pdf"],
  );
  const notice = events.find(
    (event) => event.type === "turn-item.updated" && event.payload.type === "system_notice",
  );
  assert.equal(
    notice?.payload.type === "system_notice" && notice.payload.message,
    `bb attachment unavailable: ${executorPath}`,
  );
});
