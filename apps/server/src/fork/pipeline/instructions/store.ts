import type { DatabaseSync } from "node:sqlite";
import { withForkTransaction } from "../../migrations.ts";
import { instructionSnapshotSchema } from "./types.ts";
import type { InstructionId } from "./types.ts";

export class InstructionConflictError extends Error {
  constructor() {
    super("These instructions changed since you started editing. Your draft is still here; compare it with the saved version before saving.");
    this.name = "InstructionConflictError";
  }
}

export interface InstructionOverride {
  id: InstructionId;
  content: string | null;
  /** The shipped default the custom content was saved against; null when unknown or reset. */
  savedAgainst: string | null;
  version: number;
  updatedAt: number;
}

export function createInstructionStore(db: DatabaseSync, now = Date.now) {
  const columns = "id, content, saved_against AS savedAgainst, version, updated_at AS updatedAt";
  const read = db.prepare(`SELECT ${columns} FROM instruction_overrides WHERE id = ?`);
  return {
    unpinnedCardIds(): string[] {
      return db.prepare(`SELECT s.card_id AS id FROM instruction_snapshots s
        JOIN cards c ON c.id = s.card_id WHERE c.start_requested = 1 AND c.historical = 0
          AND s.workflow_snapshot IS NULL`).all().map(({ id }) => String(id));
    },
    pinned(cardId: string): string | null {
      const row = db.prepare("SELECT workflow_snapshot, snapshot FROM instruction_snapshots WHERE card_id = ?").get(cardId);
      if (typeof row?.workflow_snapshot === "string") return row.workflow_snapshot;
      if (typeof row?.snapshot !== "string") return null;
      try {
        const parsed = instructionSnapshotSchema.safeParse(JSON.parse(row.snapshot));
        if (!parsed.success) return null;
        const documents = Object.fromEntries(Object.entries(parsed.data.documents)
          .map(([id, text]) => [id, text.replaceAll("bb pipeline", "t3 pipeline")]));
        return JSON.stringify({ ...parsed.data, documents });
      } catch {
        return null;
      }
    },
    pin(cardId: string, snapshot: string): string {
      return withForkTransaction(db, () => {
        db.prepare("UPDATE instruction_snapshots SET workflow_snapshot = ? WHERE card_id = ? AND workflow_snapshot IS NULL")
          .run(snapshot, cardId);
        const row = db.prepare("SELECT workflow_snapshot FROM instruction_snapshots WHERE card_id = ?").get(cardId);
        if (typeof row?.workflow_snapshot !== "string") throw new Error("The Pipeline task has no kickoff snapshot.");
        return row.workflow_snapshot;
      });
    },
    get(id: InstructionId): InstructionOverride | undefined {
      return read.get(id) as unknown as InstructionOverride | undefined;
    },
    all(): InstructionOverride[] {
      return db.prepare(`SELECT ${columns} FROM instruction_overrides`).all() as unknown as InstructionOverride[];
    },
    write(id: InstructionId, content: string | null, savedAgainst: string | null, expectedVersion: number): InstructionOverride {
      return withForkTransaction(db, () => {
      const current = read.get(id) as unknown as InstructionOverride | undefined;
      if ((current?.version ?? 0) !== expectedVersion) throw new InstructionConflictError();
      // Keep reset versions so an old tab cannot reuse the original default revision.
      db.prepare(`INSERT INTO instruction_overrides (id, content, saved_against, version, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET content = excluded.content, saved_against = excluded.saved_against,
          version = excluded.version, updated_at = excluded.updated_at`)
        .run(id, content, savedAgainst, expectedVersion + 1, now());
      return read.get(id) as unknown as InstructionOverride;
      });
    },
  };
}
