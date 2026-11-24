import * as Layer from "effect/Layer";

import * as ScriptAutomations from "./automations/ScriptAutomations.ts";
import { botMemoryLayer } from "./bots/service.ts";

export const layer = Layer.mergeAll(botMemoryLayer, ScriptAutomations.layer);
