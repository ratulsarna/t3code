import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../../config.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { normalizeAttachmentReferences } from "./attachmentReferences.ts";
import { eventsForThread } from "./events.ts";
import { bbProjectId, bbThreadId } from "./ids.ts";
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

const messageWithFile = (path: string): Extract<Row, { kind: "conversation" }> => ({
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
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const spool = path.join(config.baseDir, "history.jsonl");
  const mapping = path.join(config.baseDir, "workspace-map.json");
  const uploads = path.join(config.baseDir, "source-uploads");
  const write = (...records: HistoryRecord[]) =>
    fs.writeFileString(spool, records.map((record) => JSON.stringify(record)).join("\r\n") + "\n");
  const run = (workspaceMapFile?: string, threadWorkspaceMapFile?: string) =>
    Effect.scoped(
      importHistory({
        file: spool,
        attachmentRoot: uploads,
        workspaceMapFile,
        threadWorkspaceMapFile,
      }),
    );
  const projectionLayer = ProjectionStore.layer.pipe(Layer.provide(SqlitePersistence.layerConfig));
  const find = (id: string) =>
    ProjectionStore.ProjectionStoreV2.use((store) => store.findThread(bbThreadId(id))).pipe(
      Effect.provide(projectionLayer),
    );
  const messages = (id: string) =>
    ProjectionStore.ProjectionStoreV2.use((store) =>
      store.getThreadRecords(bbThreadId(id), ["messages"]),
    ).pipe(Effect.provide(projectionLayer));
  const project = (id: ProjectId) =>
    ProjectStore.ProjectStoreV2.use((store) => store.get(id)).pipe(
      Effect.map(Option.getOrThrow),
      Effect.provide(ProjectStore.layer.pipe(Layer.provide(SqlitePersistence.layerConfig))),
    );
  return { fs, path, config, mapping, uploads, write, run, find, messages, project };
});

const testServices = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
const layerTest = ServerConfig.layerTest(".", { prefix: "bb-history-review" }).pipe(
  Layer.provideMerge(testServices),
);

it.effect("an absent attachment store leaves the thread available for a corrected retry", () =>
  Effect.gen(function* () {
    const { fs, path, uploads, write, run, find, messages } = yield* fixture;
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

    const projectUploads = path.join(uploads, record.thread.project_id);
    yield* fs.makeDirectory(projectUploads);
    yield* fs.writeFileString(path.join(projectUploads, "memo.pdf"), "abc");
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
    const { fs, path, config, mapping, uploads, write, run, find } = yield* fixture;
    yield* fs.makeDirectory(uploads);
    const occupied = path.join(config.baseDir, "occupied");
    const corrected = path.join(config.baseDir, "corrected");
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

it.effect("imports literal Unicode line separators inside JSONL messages across records", () =>
  Effect.gen(function* () {
    const { fs, uploads, write, run, messages } = yield* fixture;
    yield* fs.makeDirectory(uploads);
    const first = defaultRecord("unicode-first");
    const second = defaultRecord("unicode-second");
    const text = "Before\u2028between\u2029after";
    yield* write({ ...first, items: [{ ...messageWithFile("memo.pdf"), text }] }, second);
    yield* run();
    const imported = yield* messages(first.thread.id);
    assert.deepEqual(
      imported.messages.map((message) => message.text),
      [text],
    );
    assert.deepEqual((yield* messages(second.thread.id)).messages, []);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("maps selected chats to distinct native roots and reuses an occupied root by ID", () =>
  Effect.gen(function* () {
    const { fs, path, config, mapping, uploads, write, run, find, project } = yield* fixture;
    const firstRoot = path.join(config.baseDir, "first-home");
    const secondRoot = path.join(config.baseDir, "second-home");
    yield* fs.makeDirectory(uploads);
    yield* fs.makeDirectory(firstRoot);
    yield* fs.makeDirectory(secondRoot);
    const seed = defaultRecord("occupied-root");
    yield* write(seed);
    yield* fs.writeFileString(mapping, JSON.stringify({ [seed.thread.project_id]: secondRoot }));
    yield* run(mapping);
    const existing = (yield* find(seed.thread.id))!;

    const first = defaultRecord("first-chat");
    const second = defaultRecord("second-chat");
    const common = "shared-project";
    yield* write(
      { ...first, thread: { ...first.thread, project_id: common, path: firstRoot } },
      { ...second, thread: { ...second.thread, project_id: common, path: "/former-home" } },
    );
    yield* fs.writeFileString(
      mapping,
      JSON.stringify({ [first.thread.id]: null, [second.thread.id]: secondRoot }),
    );
    yield* run(undefined, mapping);
    yield* run(undefined, mapping);
    const importedFirst = (yield* find(first.thread.id))!;
    const importedSecond = (yield* find(second.thread.id))!;
    assert.equal((yield* project(importedFirst.projectId)).workspaceRoot, firstRoot);
    assert.equal(importedSecond.projectId, existing.projectId);
    assert.equal(importedSecond.worktreePath, null);
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
    bbProjectId("alias"),
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
    notice?.type === "turn-item.updated" &&
      notice.payload.type === "system_notice" &&
      notice.payload.message,
    `bb attachment unavailable: ${executorPath}`,
  );
});
