import { createDb } from "@nexus/db";
import type { Db } from "@nexus/db";
import { logger } from "@nexus/core";

/**
 * Open the Nexus database connection via Drizzle + postgres.js.
 *
 * @param url Override POSTGRES_URL — mainly for testing.
 */
export function openDatabase(url?: string): Db {
  const { db } = createDb(url);

  logger.info("database ready (PostgreSQL via Drizzle)");
  return db;
}
