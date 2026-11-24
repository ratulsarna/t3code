import * as Migrator from "effect/sql/Migrator";

import { createScriptAutomationTables } from "./automations/schema.ts";

export const runForkMigrations = Migrator.make({})({
  table: "fork_migrations",
  loader: Migrator.fromRecord({
    "1_script_automations": createScriptAutomationTables,
  }),
});
