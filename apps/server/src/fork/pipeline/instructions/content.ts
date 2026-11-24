// @effect-diagnostics nodeBuiltinImport:off -- Source-mode CLI reads the same files that the build embeds.
import { readFile } from "node:fs/promises";
import { instructionReadInputSchema, type InstructionId } from "./types.ts";

declare const __T3CODE_PIPELINE_CONTENT__: Readonly<Record<string, string>> | undefined;

export async function readPipelineContent(path: string): Promise<string> {
  if (typeof __T3CODE_PIPELINE_CONTENT__ !== "undefined") {
    const content = __T3CODE_PIPELINE_CONTENT__[path];
    if (typeof content === "string") return content;
  } else {
    try {
      return await readFile(new URL(`../content/${path}`, import.meta.url), "utf8");
    } catch {}
  }
  throw new Error(`Pipeline document ${path} is unavailable; check the T3 installation`);
}

export async function readPackagedInstruction(id: InstructionId): Promise<string> {
  instructionReadInputSchema.parse({ id });
  return readPipelineContent(`workflows/${id}`);
}
