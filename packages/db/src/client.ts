import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/**
 * Create a postgres.js connection and wrap it with Drizzle.
 *
 * The connection string is read from POSTGRES_URL (.env at project root).
 * Call this once at startup — the returned `db` instance is safe to reuse.
 */
export function createDb(url?: string) {
  const connectionString = url ?? process.env.POSTGRES_URL;
  if (!connectionString) {
    throw new Error(
      "POSTGRES_URL environment variable is required. " +
        "Set it in .env at project root or pass a URL directly.",
    );
  }

  const client = postgres(connectionString);
  const db = drizzle(client, { schema });

  return { db, client };
}

export type Db = ReturnType<typeof createDb>["db"];
