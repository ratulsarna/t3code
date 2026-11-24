import type { GithubFeedback } from "./github-types.ts";

export function reviewedRevision(
  item: GithubFeedback,
  headSha: string,
): "current" | "different" | "unassociated" {
  if (item.commitSha !== null)
    return item.commitSha.toLowerCase() === headSha.toLowerCase() ? "current" : "different";
  const references: string[] = [];
  let fence: string | null = null;
  for (const line of item.body.split(/\r?\n/)) {
    const delimiter = line.trim().match(/^(`{3,}|~{3,})/);
    if (delimiter) {
      if (fence === null) fence = delimiter[1]!;
      else if (line.trim() === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    // Only a standalone review-revision label is evidence; arbitrary hash mentions are not.
    const label = line.match(
      /^ {0,3}(?:\*\*)?Reviewed (?:commit|revision)(?:\*\*)?:?(?:\*\*)?\s+(.+?)\.?\s*$/i,
    );
    if (!label) continue;
    const plain = label[1]!.match(/^`?([0-9a-f]{7,40})`?$/i);
    const link = label[1]!.match(
      /^\[`?([0-9a-f]{7,40})`?\]\(https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/commit\/([0-9a-f]{7,40})\)$/i,
    );
    if (plain) references.push(plain[1]!.toLowerCase());
    else if (link) references.push(link[1]!.toLowerCase(), link[2]!.toLowerCase());
  }
  if (references.length === 0) return "unassociated";
  return references.every((sha) => headSha.toLowerCase().startsWith(sha)) ? "current" : "different";
}
