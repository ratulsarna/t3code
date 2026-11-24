import * as Layer from "effect/Layer";

import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ScriptAutomations from "./automations/ScriptAutomations.ts";
import { botMemoryLayer } from "./bots/service.ts";
export { layer as apiHandlers, layerReports as routes } from "./pipeline/http.ts";
import * as Pipeline from "./pipeline/service.ts";

export const layer = Layer.mergeAll(botMemoryLayer, ScriptAutomations.layer, Pipeline.layer).pipe(
  Layer.provide(Scheduler.layer),
);
