// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { CommandId, ProjectId, type ChatAttachment } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ServerOwnership from "../../serverOwnership.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { layerEventSink, layerProjectService } from "../../orchestration-v2/runtimeLayer.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ManagedPolicy from "../../policy/ManagedPolicy.ts";
import * as ProjectEnrichment from "../../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../../project/ProjectFaviconResolver.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as T3ProjectFileLoader from "../../project/T3ProjectFileLoader.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";

import { importAttachment, openAttachmentRoot, UnavailableAttachmentError } from "./attachments.ts";
import { eventsForThread } from "./events.ts";
import { bbProjectId, bbThreadId } from "./ids.ts";
import type { HistoryRecord } from "./records.ts";

class HistoryImportError extends Schema.TaggedError<HistoryImportError>()("HistoryImportError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const decodeWorkspaceMap = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);
const decodeThreadWorkspaceMap = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
);
const readMappingFile = (file: string) =>
  Effect.tryPromise({
    try: () => NodeFSP.readFile(file, "utf8"),
    catch: (cause) => new HistoryImportError({ message: "Cannot read workspace mapping", cause }),
  });
const decodeLine = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const isUnavailableAttachment = Schema.is(UnavailableAttachmentError);
const progress = (fields: object) => Console.log(JSON.stringify(fields));

const projectEnrichment = ProjectEnrichment.layer.pipe(
  Layer.provide(
    Layer.merge(
      RepositoryIdentityResolver.layer,
      ProjectFaviconResolver.layer.pipe(
        Layer.provide(Layer.merge(WorkspacePaths.layer, T3ProjectFileLoader.layer)),
      ),
    ),
  ),
);

const layers = Layer.mergeAll(layerProjectService, layerEventSink, ProjectionStore.layer).pipe(
  Layer.provide(Layer.merge(WorkspacePaths.layer, projectEnrichment)),
  Layer.provide(ServerSettings.layer.pipe(Layer.provide(ServerSecretStore.layer))),
  Layer.provide(Layer.merge(SqlitePersistence.layerConfig, ManagedPolicy.layer)),
);

export const importHistory = Effect.fn("bbHistory.import")(function* (input: {
  readonly file: string;
  readonly attachmentRoot: string;
  readonly workspaceMapFile: string | undefined;
  readonly threadWorkspaceMapFile?: string | undefined;
}) {
  const config = yield* ServerConfig.ServerConfig;
  const attachmentRoot = yield* Effect.tryPromise({
    try: () => openAttachmentRoot(input.attachmentRoot),
    catch: (cause) => new HistoryImportError({ message: "Cannot open bb attachment root", cause }),
  });
  yield* ServerOwnership.holdServerOwnershipLock(config.serverRuntimeStatePath);

  const work = Effect.gen(function* () {
    const projects = yield* ProjectService.ProjectService;
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const sink = yield* EventSink.EventSinkV2;
    const fs = yield* FileSystem.FileSystem;
    const workspaceRoots =
      input.workspaceMapFile === undefined
        ? {}
        : yield* readMappingFile(input.workspaceMapFile).pipe(Effect.flatMap(decodeWorkspaceMap));
    const threadWorkspaceRoots =
      input.threadWorkspaceMapFile === undefined
        ? {}
        : yield* readMappingFile(input.threadWorkspaceMapFile).pipe(
            Effect.flatMap(decodeThreadWorkspaceMap),
          );
    // Node readline also splits on U+2028 and U+2029, which are valid inside JSON strings.
    const lines = fs.stream(input.file).pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.mapError(
        (cause) => new HistoryImportError({ message: "Cannot read decoded bb history", cause }),
      ),
    );
    const openedProjects = new Set<string>();
    let written = 0;
    let skipped = 0;
    let eventCount = 0;
    let attachmentBytes = 0;
    const started = performance.now();
    const importLine = Effect.fnUntraced(function* (line: string) {
      if (!line.trim()) return;
      const record = (yield* decodeLine(line)) as HistoryRecord;
      const { thread } = record;
      const threadId = bbThreadId(thread.id);
      const workspaceOverride = Object.hasOwn(threadWorkspaceRoots, thread.id)
        ? (threadWorkspaceRoots[thread.id] ?? thread.path ?? "").trim()
        : undefined;
      if (workspaceOverride !== undefined && !NodePath.isAbsolute(workspaceOverride)) {
        return yield* new HistoryImportError({
          message: `Thread ${threadId} requires an absolute workspace path`,
        });
      }
      const existing = yield* store.findThread(threadId);
      if (existing) {
        if (existing.historyOrigin !== "bb_import") {
          return yield* new HistoryImportError({
            message: `Thread ID ${threadId} is already in use`,
          });
        }
        if (workspaceOverride !== undefined) {
          const project = yield* projects.getByWorkspaceRoot(workspaceOverride);
          if (
            Option.isNone(project) ||
            project.value.id !== existing.projectId ||
            existing.worktreePath !== null
          ) {
            return yield* new HistoryImportError({
              message: `Thread ${threadId} already imported with a different workspace`,
            });
          }
        }
        // The thread creation and transcript commit together in EventSink.
        skipped++;
        return;
      }

      let projectId = bbProjectId(thread.project_id);
      if (workspaceOverride !== undefined) {
        const root = NodePath.resolve(workspaceOverride);
        const digest = NodeCrypto.createHash("sha256").update(root).digest("hex");
        const { project } = yield* projects.bootstrap({
          commandId: CommandId.make(`bb-history:create:${NodeCrypto.randomUUID()}`),
          projectId: ProjectId.make(`bb-workspace-${digest}`),
          title: NodePath.basename(root) || thread.project_name,
          workspaceRoot: root,
        });
        projectId = project.id;
      } else if (!openedProjects.has(projectId)) {
        const existingProject = yield* projects.getById(projectId, { includeDeleted: true });
        if (Option.isNone(existingProject)) {
          const workspaceRoot = Object.hasOwn(workspaceRoots, thread.project_id)
            ? workspaceRoots[thread.project_id]!
            : NodePath.join(config.baseDir, "history-projects", projectId);
          yield* projects.create({
            commandId: CommandId.make(`bb-history:create:${NodeCrypto.randomUUID()}`),
            projectId,
            title: thread.project_name.trim() || "bb project",
            workspaceRoot,
            createWorkspaceRootIfMissing: !Object.hasOwn(workspaceRoots, thread.project_id),
          });
        } else if (existingProject.value.deletedAt !== null) {
          return yield* new HistoryImportError({ message: `Project ${projectId} was deleted` });
        }
        openedProjects.add(projectId);
      }

      const attachments = new Map<string, ChatAttachment>();
      const unavailable = new Map<string, string>();
      for (const source of record.attachments) {
        const copied = yield* Effect.result(
          Effect.tryPromise({
            try: () => importAttachment(attachmentRoot, config.attachmentsDir, threadId, source),
            catch: (cause) =>
              new HistoryImportError({ message: "Cannot stage bb attachment", cause }),
          }),
        );
        if (copied._tag === "Failure") {
          if (!isUnavailableAttachment(copied.failure.cause)) {
            return yield* copied.failure;
          }
          unavailable.set(source.stored_path, copied.failure.cause.message);
          continue;
        }
        const { attachment, digest } = copied.success;
        attachments.set(source.stored_path, attachment);
        attachmentBytes += attachment.sizeBytes;
        yield* progress({
          threadId,
          attachmentId: attachment.id,
          bytes: attachment.sizeBytes,
          digest,
        });
      }
      const events = eventsForThread(
        record,
        projectId,
        attachments,
        unavailable,
        record.links.importedChildren,
      );
      const committed = yield* sink.write({ events });
      eventCount += committed.length;
      written++;
      yield* progress({ threadId, events: committed.length, unavailable: unavailable.size });
    });
    yield* Stream.runForEach(lines, importLine);
    yield* progress({
      written,
      skipped,
      eventCount,
      attachmentBytes,
      seconds: (performance.now() - started) / 1000,
    });
  });
  yield* work.pipe(Effect.provide(layers));
});
