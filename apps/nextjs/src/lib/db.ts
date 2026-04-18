import { createDb } from "@nexus/db";
import type { Db } from "@nexus/db";
import { asReadOnly } from "@nexus/db/readonly";
import type { ReadOnlyDb } from "@nexus/db/readonly";

/**
 * Singleton database connection for Server Actions and server components.
 *
 * Uses POSTGRES_URL from .env. The connection is created lazily on first
 * access and reused for the lifetime of the process (Next.js serverless
 * function or long-running dev server).
 */

let _db: Db | null = null;

function _getDb(): Db {
  if (!_db) {
    const { db } = createDb();
    _db = db;
  }
  return _db;
}

/**
 * Narrowed read-only view of the DB singleton.
 *
 * The only public DB accessor exported from this module. All Server Actions
 * and route handlers in apps/nextjs type their handle as ReadOnlyDb — the
 * type system enforces that no writes can compile. All write paths must go
 * through the agent HTTP API.
 */
export function getReadOnlyDb(): ReadOnlyDb {
  return asReadOnly(_getDb());
}
