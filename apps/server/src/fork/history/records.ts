export interface Attachment {
  readonly project_id: string;
  readonly stored_path: string;
  readonly original_name: string;
  readonly mime_type: string | null;
  readonly size_bytes: number;
}

interface RowBase {
  readonly nested: boolean;
  readonly startedAt: number;
  readonly createdAt: number;
}

interface ConversationRow extends RowBase {
  readonly kind: "conversation";
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly senderThreadId?: string | null;
  readonly turnRequest: { readonly status: string } | null;
  readonly attachments: {
    readonly localImagePaths: readonly string[];
    readonly localFilePaths: readonly string[];
    readonly imageUrls: readonly string[];
  } | null;
}

interface SystemRow extends RowBase {
  readonly kind: "system";
  readonly operationKind?: string;
  readonly systemKind: string;
  readonly title: string;
  readonly detail: string | null;
  readonly completedAt?: number | null;
  readonly status: string | null;
}

interface WorkRowBase extends RowBase {
  readonly kind: "work";
  readonly workKind: string;
  readonly status: string;
  readonly completedAt?: number | null;
}

export type WorkRow = WorkRowBase &
  (
    | {
        readonly workKind: "command";
        readonly command: string;
        readonly output: string;
        readonly exitCode: number | null;
      }
    | {
        readonly workKind: "tool";
        readonly toolName: string;
        readonly toolArgs: unknown;
        readonly output: string;
      }
    | {
        readonly workKind: "file-change";
        readonly change: {
          readonly path: string;
          readonly kind: string | null;
          readonly movePath: string | null;
          readonly diff: string | null;
          readonly diffStats: { readonly added: number; readonly removed: number };
        };
      }
    | { readonly workKind: "web-search"; readonly queries: readonly string[] }
    | {
        readonly workKind: "question";
        readonly interactionId: string;
        readonly lifecycle: string;
        readonly questions: ReadonlyArray<{
          readonly id: string;
          readonly shortLabel?: string;
          readonly prompt: string;
          readonly multiSelect: boolean;
          readonly allowFreeText: boolean;
          readonly required: boolean;
          readonly options?: ReadonlyArray<{
            readonly value: string;
            readonly label: string;
            readonly description?: string;
          }>;
        }>;
        readonly answers: Record<
          string,
          { readonly selected: readonly string[]; readonly freeText?: string }
        > | null;
      }
    | {
        readonly workKind: "approval";
        readonly interactionId: string;
        readonly lifecycle: string;
        readonly approvalKind: "file-edit" | "permission-grant";
        readonly statusReason?: string | null;
        readonly target: { readonly toolName: string | null };
      }
    | {
        readonly workKind:
          | "form"
          | "file-read"
          | "web-fetch"
          | "image-view"
          | "image-generation"
          | "search"
          | "plan-steps"
          | "extension"
          | "delegation"
          | "workflow";
      }
  );

export type Row = ConversationRow | SystemRow | WorkRow;

export interface HistoryRecord {
  readonly thread: {
    readonly id: string;
    readonly project_id: string;
    readonly project_name: string;
    readonly project_remote: string | null;
    readonly project_sort_key: string;
    readonly provider_id: string;
    readonly model: string | null;
    readonly title: string | null;
    readonly title_fallback: string | null;
    readonly status: string;
    readonly visibility: string;
    readonly section_id: string | null;
    readonly created_at: number;
    readonly updated_at: number;
    readonly archived_at: number | null;
    readonly pinned_at: number | null;
    readonly pin_sort_key: string | null;
    readonly last_read_at: number | null;
    readonly source_thread_id: string | null;
    readonly parent_thread_id: string | null;
    readonly lifecycle_owner_thread_id: string | null;
    readonly environment_id: string | null;
    readonly path: string | null;
    readonly branch_name: string | null;
    readonly host_id: string | null;
    readonly host_name: string | null;
  };
  readonly links: {
    readonly children: readonly string[];
    readonly importedChildren: readonly string[];
    readonly forkParent: string | null;
    readonly forkRoot: string;
  };
  readonly items: readonly Row[];
  readonly attachments: readonly Attachment[];
}
