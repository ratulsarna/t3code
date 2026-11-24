// @effect-diagnostics nodeBuiltinImport:off -- Vite and the standalone executable embed the same Pipeline resources.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function pipelineContentDefine(root: string): string {
  const content = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()
    .map((file) => [file.slice(root.length + 1).replaceAll("\\", "/"), readFileSync(file, "utf8")]);
  return JSON.stringify(Object.fromEntries(content));
}
