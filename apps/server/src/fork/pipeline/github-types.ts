import { z, type Infer } from "./zod.ts";

export const githubCheckSchema = z
  .object({
    name: z.string(),
    state: z.enum(["pending", "passed", "failed", "skipped", "cancelled"]),
    url: z.string().nullable(),
  })
  .strict();

export interface GithubFeedback {
  id: string;
  kind: "review" | "inline" | "comment";
  author: string;
  body: string;
  url: string;
  commitSha: string | null;
  state: string | null;
  updatedAt: number;
  inReplyTo: string | null;
}

export interface GithubSnapshot {
  url: string;
  number: number;
  state: "open" | "closed" | "merged";
  draft: boolean;
  headSha: string;
  author: string;
  checks: Infer<typeof githubCheckSchema>[];
  mergeable: "mergeable" | "conflicting" | "unknown";
  reviewDecision: string | null;
  feedback: GithubFeedback[];
  fetchedAt: number;
}

export const githubStatusSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    url: z.string(),
    number: z.number().int().positive().nullable(),
    state: z.enum(["open", "closed", "merged"]),
    draft: z.boolean(),
    headSha: z.string(),
    checks: z.array(githubCheckSchema),
    mergeable: z.enum(["mergeable", "conflicting", "unknown"]),
    reviewDecision: z.string().nullable(),
    review: z.enum(["waiting", "feedback", "clear", "unknown"]),
    followup: z.enum(["pending", "delivered", "handled", "cancelled"]).nullable(),
    manualReviewPending: z.boolean().optional(),
    batchId: z.string().nullable(),
    syncedAt: z.number().nullable(),
    error: z.string().nullable(),
  })
  .strict();

export type GithubStatus = Infer<typeof githubStatusSchema>;

export interface ReviewBatch {
  manualDispatch?: boolean;
  id: string;
  headSha: string;
  feedback: GithubFeedback[];
  state: "pending" | "sending" | "delivered" | "handled" | "cancelled";
}

export interface GithubSyncState {
  status: GithubStatus;
  observed: Record<string, string>;
  batch: ReviewBatch | null;
}

export function initialGithubState(url: string): GithubSyncState {
  return {
    status: {
      revision: 0,
      url,
      number: null,
      state: "open",
      draft: true,
      headSha: "",
      checks: [],
      mergeable: "unknown",
      reviewDecision: null,
      review: "waiting",
      followup: null,
      batchId: null,
      syncedAt: null,
      error: null,
    },
    observed: {},
    batch: null,
  };
}
