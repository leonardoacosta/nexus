import { createDb } from "@nexus/db";
import type { Db } from "@nexus/db";

/**
 * Singleton database connection for Server Actions and server components.
 *
 * Uses POSTGRES_URL from .env. The connection is created lazily on first
 * access and reused for the lifetime of the process (Next.js serverless
 * function or long-running dev server).
 */

let _db: Db | null = null;

export function getDb(): Db {
  if (!_db) {
    const { db } = createDb();
    _db = db;
  }
  return _db;
}
