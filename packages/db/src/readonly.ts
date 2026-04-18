import type { Db } from "./client";

/**
 * A narrowed view of `Db` that exposes only read operations.
 * Use this in apps/nextjs to ensure no write paths can compile.
 *
 * Omitted methods: insert, update, delete, execute (raw SQL), transaction.
 * Retained methods: select, query, and the relational query API.
 */
export type ReadOnlyDb = Omit<
  Db,
  "insert" | "update" | "delete" | "execute" | "transaction"
>;

/**
 * Runtime cast for test fixtures and production call sites.
 * The type system enforces the read-only boundary at compile time;
 * this helper makes the narrowing explicit at the import site so any
 * future direct `.insert()` call is a type error, not a runtime surprise.
 */
export function asReadOnly(db: Db): ReadOnlyDb {
  return db as ReadOnlyDb;
}
