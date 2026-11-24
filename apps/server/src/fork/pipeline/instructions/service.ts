import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { readGuidelines as readExternalGuidelines, type GuidelinesSettings } from "./guidelines.ts";
import { readWorkflow } from "./workflow.ts";
import { readPackagedInstruction, readPipelineContent } from "./content.ts";
import { validateInstructionFields } from "./template.ts";
import { createInstructionStore, InstructionConflictError, type InstructionOverride } from "./store.ts";
import {
  INSTRUCTION_DOCUMENTS, PROCEDURES, missingProcedures, instructionReadInputSchema, instructionSaveInputSchema, instructionResetInputSchema, instructionSnapshotSchema,
  type InstructionId, type InstructionDocument, type InstructionReader, type InstructionSnapshot,
  type InstructionSaveInput, type InstructionResetInput,
} from "./types.ts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export { readPackagedInstruction } from "./content.ts";

export function snapshotInstructionReader(snapshot: InstructionSnapshot): InstructionReader {
  return {
    async readContent(id) {
      instructionReadInputSchema.parse({ id });
      const content = snapshot.documents[id];
      if (typeof content !== "string") throw new Error(`Pipeline instruction snapshot is missing ${id}`);
      return content;
    },
  };
}

export function createInstructionService(options: {
  db: DatabaseSync;
  getSettings?: () => Promise<GuidelinesSettings>;
  publish?: () => void;
  readDefault?: (id: InstructionId) => Promise<string>;
  readReviewPrompts?: () => Promise<NonNullable<InstructionSnapshot["reviewPrompts"]>>;
}) {
  const store = createInstructionStore(options.db);
  const readDefault = options.readDefault ?? readPackagedInstruction;
  function pinned(cardId: string): InstructionSnapshot | null {
    const saved = store.pinned(cardId);
    if (saved === null) return null;
    const snapshot = instructionSnapshotSchema.parse(JSON.parse(saved));
    return snapshot;
  }
  function document(id: InstructionId, defaultContent: string, override?: InstructionOverride): InstructionDocument {
    const entry = INSTRUCTION_DOCUMENTS.find((entry) => entry.id === id)!;
    const custom = override?.content != null;
    // A custom document saved before Pipeline recorded its base has an unknown base, so it counts as changed.
    const savedAgainst = custom ? override.savedAgainst : null;
    return {
      ...entry,
      source: custom ? "custom" : "default",
      shippedChanged: custom && savedAgainst !== defaultContent,
      savedAgainst,
      revision: hash([id, defaultContent, override?.version ?? 0]),
      updatedAt: override?.updatedAt ?? null,
      content: override?.content ?? defaultContent,
      defaultContent,
    };
  }
  async function read(input: { id: InstructionId }) {
    const { id } = instructionReadInputSchema.parse(input);
    const defaultContent = await readDefault(id);
    return document(id, defaultContent, store.get(id));
  }
  async function all() {
    const defaults = await Promise.all(INSTRUCTION_DOCUMENTS.map(({ id }) => readDefault(id)));
    const overrides = new Map(store.all().map((entry) => [entry.id, entry]));
    return INSTRUCTION_DOCUMENTS.map(({ id }, index) => document(id, defaults[index]!, overrides.get(id)));
  }
  async function write(input: InstructionResetInput, content: string | null) {
    await service.pinStarted();
    const defaultContent = await readDefault(input.id);
    const current = store.get(input.id);
    if (document(input.id, defaultContent, current).revision !== input.expectedRevision) throw new InstructionConflictError();
    const saved = document(input.id, defaultContent, store.write(input.id, content, content === null ? null : defaultContent, current?.version ?? 0));
    options.publish?.();
    return saved;
  }
  async function guidelines(settings?: GuidelinesSettings, snapshot?: InstructionSnapshot) {
    if (snapshot) return { source: "Pipeline task guidelines", content: await snapshotInstructionReader(snapshot).readContent("guidelines/README.md") };
    const configured = settings ?? await options.getSettings?.() ?? {};
    if (configured.guidelinesFile?.trim()) return readExternalGuidelines(configured);
    return { source: "Pipeline's guidelines", content: (await read({ id: "guidelines/README.md" })).content };
  }
  const service = {
    async list() {
      return { documents: (await all()).map(({ content, defaultContent, savedAgainst, ...summary }) => summary) };
    },
    read,
    save(input: InstructionSaveInput) {
      const parsed = instructionSaveInputSchema.parse(input);
      validateInstructionFields(parsed.id, parsed.content);
      if (parsed.id === "implement/README.md") {
        const missing = missingProcedures(parsed.content);
        if (missing.length > 0 && missing.length < PROCEDURES.length) throw new Error(`Implementation instructions must name all procedures or none; missing: ${missing.join(", ")}`);
      }
      return write(parsed, parsed.content);
    },
    reset(input: InstructionResetInput) {
      return write(instructionResetInputSchema.parse(input), null);
    },
    async readContent(id: InstructionId) {
      return (await read({ id })).content;
    },
    readWorkflow(phase = "overview", file?: string, snapshot?: InstructionSnapshot) {
      return readWorkflow(phase, file, snapshot ? snapshotInstructionReader(snapshot) : service);
    },
    readGuidelines: guidelines,
    pinned,
    async pinStarted(settings?: GuidelinesSettings): Promise<void> {
      const ids = store.unpinnedCardIds().filter((id) => pinned(id) === null);
      if (ids.length === 0) return;
      const snapshot = JSON.stringify(await service.snapshot(settings));
      for (const id of ids) store.pin(id, snapshot);
    },
    async pin(cardId: string, settings?: GuidelinesSettings): Promise<InstructionSnapshot> {
      const existing = pinned(cardId);
      if (existing) return existing;
      const snapshot = await service.snapshot(settings);
      return instructionSnapshotSchema.parse(JSON.parse(store.pin(cardId, JSON.stringify(snapshot))));
    },
    async snapshot(settings?: GuidelinesSettings): Promise<InstructionSnapshot> {
      const configured = settings ?? await options.getSettings?.() ?? {};
      const external = configured.guidelinesFile?.trim() ? await readExternalGuidelines(configured) : null;
      const documents = Object.fromEntries((await all()).map(({ id, content }) => [id, content])) as InstructionSnapshot["documents"];
      if (external) documents["guidelines/README.md"] = external.content;
      const reviewPrompts = await (options.readReviewPrompts?.() ?? (async () => {
        const [review, shape, comment, fixPlan, settled] = await Promise.all(["review-prompt.txt", "shape-review-prompt.txt", "comment-review-prompt.txt", "fix-plan-prompt.txt", "settled-prompt.txt"]
          .map((file) => readPipelineContent(`skills/pair-review/${file}`)));
        return { review: review!, shape: shape!, comment: comment!, fixPlan: fixPlan!, settled: settled! };
      })());
      return { revision: hash({ documents, reviewPrompts }), documents, reviewPrompts };
    },
  };
  return service;
}

export type InstructionService = ReturnType<typeof createInstructionService>;
