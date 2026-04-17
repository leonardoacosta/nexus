import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Options } from "postgres";
import * as schema from "./schema";

/**
 * Create a postgres.js connection and wrap it with Drizzle.
 *
 * The connection string is read from POSTGRES_URL (.env at project root).
 * Call this once at startup — the returned `db` instance is safe to reuse.
 *
 * `options` is passed through to postgres.js. The primary use case is
 * integration tests that need to pin every pooled connection to a
 * non-default `search_path`:
 *
 *     createDb(url, { connection: { search_path: '"nx_test_xyz",public' } })
 *
 * postgres.js applies `connection.*` values to every new connection via
 * the startup packet, so this is the correct way to scope the whole pool
 * to an isolated schema.
 */
export function createDb(
  url?: string,
  options?: Options<Record<string, never>>,
) {
  const connectionString = url ?? process.env.POSTGRES_URL;
  if (!connectionString) {
    throw new Error(
      "POSTGRES_URL environment variable is required. " +
        "Set it in .env at project root or pass a URL directly.",
    );
  }

  const client = postgres(connectionString, options ?? {});
  const db = drizzle(client, { schema });

  return { db, client };
}

export type Db = ReturnType<typeof createDb>["db"];
