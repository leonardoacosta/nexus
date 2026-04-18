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
 * Full Db instance for server-side reads (select queries).
 *
 * NOTE: Even though this returns `Db`, all direct writes from apps/nextjs are
 * forbidden — use the agent HTTP API instead. This alias is intentionally NOT
 * exported as `ReadOnlyDb` because some callers (e.g. drizzle `.select()` with
 * joins) rely on the full Drizzle query builder surface. The ESLint guard on
 * apps/nextjs prevents importing `Db` type by name, but this factory function
 * is the one deliberate exception (lib/db.ts is the DB factory).
 */
export function getDb(): Db {
  return _getDb();
}

/**
 * Narrowed read-only view of the DB singleton.
 *
 * Use this wherever the consumer only needs reads and you want the type system
 * to enforce that no writes can compile. All write paths must go through the
 * agent HTTP API.
 */
export function getReadOnlyDb(): ReadOnlyDb {
  return asReadOnly(_getDb());
}
