import { sql } from "drizzle-orm";
import { createDb } from "@nexus/db";
import type { Db } from "@nexus/db";
import { logger } from "@nexus/core/node";

/**
 * Open the Nexus database connection via Drizzle + postgres.js.
 *
 * @param url Override POSTGRES_URL — mainly for testing.
 */
export function openDatabase(url?: string): Db {
  const { db } = createDb(url);

  // Belt-and-suspenders: ensure the notification_settings sentinel row exists
  // even when migrations were bypassed (drizzle-kit push, partial restore,
  // dev DB reset, etc.). The seed is idempotent — ON CONFLICT DO NOTHING
  // makes this a true no-op when the row is already present. Fire-and-forget
  // so a slow/unreachable DB does not block agent boot; errors are logged but
  // do not abort startup (the route layer handles missing settings gracefully).
  void db
    .execute(
      sql`INSERT INTO "notification_settings" ("id", "tts_enabled", "banner_enabled", "ducking_mode", "updated_at")
          VALUES (1, true, true, 'full', now())
          ON CONFLICT ("id") DO NOTHING`,
    )
    .catch((err: unknown) => {
      logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        "notification_settings seed verification failed — continuing boot",
      );
    });

  logger.info("database ready (PostgreSQL via Drizzle)");
  return db;
}
