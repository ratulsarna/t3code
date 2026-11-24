import type { Row } from "./records.ts";

export function normalizeAttachmentReferences(
  row: Row,
  uploadedPaths: (path: string) => ReadonlyArray<string>,
  inventory: ReadonlySet<string>,
): Row {
  if (row.kind !== "conversation" || row.attachments === null) return row;
  const uploadReference = (path: string) => {
    const [canonical] = uploadedPaths(path);
    return canonical !== undefined && inventory.has(canonical) ? canonical : path;
  };
  return {
    ...row,
    attachments: {
      ...row.attachments,
      localImagePaths: row.attachments.localImagePaths.map(uploadReference),
      localFilePaths: row.attachments.localFilePaths.map(uploadReference),
    },
  };
}
