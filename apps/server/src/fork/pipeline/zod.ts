// @effect-diagnostics nodeBuiltinImport:off -- The standalone CLI resolves Zod from its runtime dependencies.
import * as NodeModule from "node:module";

export type { infer as Infer, ZodType } from "zod";

export const { z } = NodeModule.createRequire(import.meta.url)("zod") as typeof import("zod");
