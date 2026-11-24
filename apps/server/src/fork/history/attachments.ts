// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { ChatAttachment, type ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  attachmentFileExtension,
  createDeterministicAttachmentId,
  resolveAttachmentPath,
} from "../../attachmentStore.ts";
import type { Attachment } from "./records.ts";

const isAttachment = Schema.is(ChatAttachment);

function inside(parent: string, path: string): boolean {
  const child = NodePath.relative(parent, path);
  return (
    child !== "" &&
    !NodePath.isAbsolute(child) &&
    child !== ".." &&
    !child.startsWith(".." + NodePath.sep)
  );
}

export class UnavailableAttachmentError extends Schema.TaggedError<UnavailableAttachmentError>()(
  "UnavailableAttachmentError",
  { message: Schema.String },
) {}

async function readSource(rootPath: string, source: Attachment): Promise<Buffer> {
  const root = await NodeFSP.realpath(rootPath);
  const project = await NodeFSP.realpath(NodePath.resolve(root, source.project_id));
  const path = await NodeFSP.realpath(NodePath.resolve(project, source.stored_path));
  if (!inside(root, project) || !inside(project, path)) {
    throw new Error("Path is outside the bb project attachment store");
  }
  const info = await NodeFSP.stat(path);
  if (!info.isFile() || info.size !== source.size_bytes)
    throw new Error("Size does not match inventory");
  const data = await NodeFSP.readFile(path);
  if (data.length !== info.size) throw new Error("Source changed while reading");
  return data;
}

export async function importAttachment(
  sourceRoot: string,
  attachmentsDir: string,
  threadId: ThreadId,
  source: Attachment,
): Promise<{ attachment: ChatAttachment; digest: string }> {
  const name = source.original_name.trim();
  const mimeType = source.mime_type?.trim() || "application/octet-stream";
  const type = mimeType.startsWith("image/") ? "image" : "file";
  const data = await readSource(sourceRoot, source).catch((cause: unknown) => {
    throw new UnavailableAttachmentError({
      message: cause instanceof Error ? cause.message : String(cause),
    });
  });
  const digest = NodeCrypto.createHash("sha256").update(data).digest("hex");
  const stableId = createDeterministicAttachmentId(
    threadId,
    JSON.stringify([source.project_id, source.stored_path, digest]),
  );
  if (stableId === null) throw new Error("Invalid destination attachment ID");
  const id = type === "file" ? `${stableId}-${attachmentFileExtension(name).slice(1)}` : stableId;
  const attachment = { id, type, name, mimeType, sizeBytes: data.length };
  if (!isAttachment(attachment)) {
    throw new UnavailableAttachmentError({
      message: "Attachment is outside T3's supported limits",
    });
  }
  const path = resolveAttachmentPath({ attachmentsDir, attachment });
  if (path === null) throw new Error("Invalid destination attachment path");
  const tempPath = `${path}.${NodeCrypto.randomUUID()}.part`;
  try {
    await NodeFSP.writeFile(tempPath, data, { mode: 0o600, flag: "wx" });
    await NodeFSP.rename(tempPath, path);
  } finally {
    await NodeFSP.rm(tempPath, { force: true });
  }
  return { attachment, digest };
}
