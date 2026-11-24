import { z, type Infer } from "./zod.ts";

export const githubIssueCommentSchema = z.object({
  author: z.string(),
  body: z.string(),
  url: z.string().url(),
  createdAt: z.string(),
});

export type GithubIssueComment = Infer<typeof githubIssueCommentSchema>;

export const githubIssueSummarySchema = z.object({
  url: z.string().url(),
  number: z.number().int().positive(),
  title: z.string(),
  state: z.enum(["open", "closed"]),
  labels: z.array(z.string()),
  assignees: z.array(z.string()),
  updatedAt: z.string(),
});

export type GithubIssueSummary = Infer<typeof githubIssueSummarySchema>;

export const githubIssueDetailsSchema = githubIssueSummarySchema.extend({
  body: z.string(),
  comments: z.array(githubIssueCommentSchema),
});

export type GithubIssueDetails = Infer<typeof githubIssueDetailsSchema>;

export const importedIssueSchema = githubIssueDetailsSchema.extend({
  importedBy: z.string(),
  syncedAt: z.number(),
  error: z.string().nullable(),
});

export type ImportedIssue = Infer<typeof importedIssueSchema>;
