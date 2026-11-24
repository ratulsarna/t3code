const branchPrefix = "pipeline/card-";
const managedBranch = /^pipeline\/card-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export const pipelineWorktreeBranch = (cardId: string) => branchPrefix + cardId;

const importedLaunchPrefix = "pipeline:imported-launch:";
const importedThreadPrefix = "mcp:pipeline-import:";
export const importedLaunchKey = (cardId: string) => importedLaunchPrefix + cardId;
export const importedLaunchId = (key: string, digest: string) =>
  key.startsWith(importedLaunchPrefix) ? importedThreadPrefix + digest : null;

export const isPipelineWorktree = (thread: {
  readonly id: string;
  readonly linkOrigin?: unknown;
  readonly branch: string | null;
  readonly worktreePath: string | null;
}) =>
  thread.linkOrigin !== undefined &&
  thread.worktreePath !== null &&
  (thread.id.startsWith(importedThreadPrefix) ||
    (thread.branch !== null && managedBranch.test(thread.branch)));
