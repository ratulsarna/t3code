import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN provider_thread_id TEXT
  `;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN parent_thread_id TEXT
  `;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN origin_json TEXT
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_projection_threads_provider_thread_id
    ON projection_threads(provider_thread_id)
    WHERE provider_thread_id IS NOT NULL
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_parent_thread_id
    ON projection_threads(parent_thread_id)
  `;
});
