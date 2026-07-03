import { drizzle } from "drizzle-orm/postgres-js";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type { MigrationMeta } from "drizzle-orm/migrator";
import postgres from "postgres";

const MIGRATIONS_FOLDER = "./drizzle";

// Postgres "object already exists" SQLSTATE class. These are exactly the errors
// `drizzle-kit push` leaves behind: it live-diffs the schema into the DB without
// writing drizzle.__drizzle_migrations, so a later file-replay migrate() tries to
// re-create objects that already exist.
//   42701 duplicate_column            42P07 duplicate_table
//   42710 duplicate_object            42P06 duplicate_schema
//   42P16 invalid_table_definition (… already a foo)  42723 duplicate_function
//   42P05 duplicate_prepared_statement
const ALREADY_EXISTS_CODES = new Set([
  "42701",
  "42P07",
  "42710",
  "42P06",
  "42723",
  "42P05",
]);

export function isAlreadyExists(err: unknown): err is postgres.PostgresError {
  return (
    err instanceof Error &&
    "code" in err &&
    typeof (err as { code?: unknown }).code === "string" &&
    ALREADY_EXISTS_CODES.has((err as { code: string }).code)
  );
}

// Recovery path #1 (FULLY-empty journal): when an earlier `drizzle-kit push`
// created the schema without populating drizzle.__drizzle_migrations at all, a
// subsequent migrate() retries every migration from idx 0 and crashes on
// "relation X already exists". Back-fill the tracking table so migrate becomes a
// no-op. Idempotent (skips when tracking already has rows or no app schema yet).
async function recoverTrackingIfNeeded(client: postgres.Sql) {
  const trackingExists = await client<
    { n: number }[]
  >`SELECT count(*)::int AS n FROM information_schema.tables
       WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations'`;
  if (trackingExists[0]!.n === 0) return; // truly fresh — let migrate() create it

  const tracked = await client<
    { n: number }[]
  >`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
  if (tracked[0]!.n > 0) return; // already populated — normal upgrade path

  const appTables = await client<
    { n: number }[]
  >`SELECT count(*)::int AS n FROM information_schema.tables
       WHERE table_schema = 'public'`;
  if (appTables[0]!.n === 0) return; // empty public schema — normal fresh path

  console.log(
    `[migrate] tracking empty but ${appTables[0]!.n} public tables exist — back-filling __drizzle_migrations`,
  );
  const migrations = readMigrationFiles({
    migrationsFolder: MIGRATIONS_FOLDER,
  });
  // postgres.js types `TransactionSql` as `Omit<Sql, ...>`; TS `Omit` is a
  // mapped type that drops call signatures, so the tagged-template form on
  // `tx` is lost at the type level (TS2349) even though the runtime object is
  // a fully-callable tx-scoped sql tag. Re-narrow to the callable `Sql` shape
  // — this is a pure type-level fix, the parameterized query is unchanged.
  await client.begin(async (txRaw) => {
    const tx = txRaw as unknown as postgres.Sql;
    for (const m of migrations) {
      await tx`INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
               VALUES (${m.hash}, ${m.folderMillis})`;
    }
  });
  console.log(`[migrate] back-filled ${migrations.length} tracking rows`);
}

// Recovery path #2 (PARTIAL journal — the db:push-on-every-batch signature):
//
// The deploy applies schema via `db:push` (live-diff, writes NO journal rows),
// then the deploy hook runs `db:migrate` (file replay). drizzle's migrator
// decides what to apply purely by `max(created_at) < folderMillis` — it does
// NOT match by hash. So after a db:push lands migration N's objects, the journal
// is still at N-1 and migrate() tries to replay N, colliding with the objects
// db:push already created (e.g. `column "vector" of relation "fleet_presence"
// already exists`, SQLSTATE 42701).
//
// This is a SELF-HEALING reimplementation of drizzle's own migrate loop (see
// drizzle-orm/pg-core/dialect.js `async migrate`). It is byte-for-byte the same
// decision + insert contract, with one addition: when a pending migration's SQL
// hits the "object already exists" class, we treat that statement as a no-op
// (db:push already applied it), record the migration's (hash, folderMillis), and
// continue — instead of aborting the whole deploy. A genuinely-new migration
// whose objects DON'T exist still runs and records normally; only the
// already-exists class is swallowed, so we never silently skip real DDL.
//
// Per-migration transaction: each migration commits independently so a recorded
// "already applied" row survives even if a later, genuinely-new migration fails.
// This matches the desired self-heal semantics (advance the journal past what
// db:push already did) while keeping each migration atomic.
export async function selfHealingMigrate(
  client: postgres.Sql,
  migrationsFolder: string = MIGRATIONS_FOLDER,
  // The migrations-tracking schema. Defaults to drizzle's own "drizzle". Tests
  // override this to an isolated schema so they don't read/write the real
  // production journal (whose created_at high-watermark would skip fixtures).
  migrationsSchema = "drizzle",
) {
  const migrations = readMigrationFiles({
    migrationsFolder,
  });

  const schema = client(migrationsSchema);
  await client`CREATE SCHEMA IF NOT EXISTS ${schema}`; // SAFE: schema is a postgres.js identifier fragment (migration bookkeeping schema, default "drizzle"), never request data
  await client`
    CREATE TABLE IF NOT EXISTS ${schema}.__drizzle_migrations ( /*// SAFE: schema is a postgres.js identifier fragment (migration bookkeeping schema), not request data */
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )`;

  const lastRows = await client<{ created_at: string | null }[]>`
    SELECT created_at FROM ${schema}.__drizzle_migrations /*// SAFE: schema is a postgres.js identifier fragment (migration bookkeeping schema), not request data */
    ORDER BY created_at DESC LIMIT 1`;
  const lastCreatedAt =
    lastRows[0]?.created_at != null ? Number(lastRows[0].created_at) : null;

  let appliedCount = 0;
  let healedCount = 0;

  for (const migration of migrations) {
    // drizzle's exact gate: skip anything already covered by the journal high
    // watermark. Pure created_at comparison, no hash matching.
    if (lastCreatedAt !== null && lastCreatedAt >= migration.folderMillis) {
      continue;
    }
    const result = await applyOneMigration(client, migration, migrationsSchema);
    if (result === "healed") healedCount++;
    else appliedCount++;
  }

  if (appliedCount === 0 && healedCount === 0) {
    console.log("[migrate] journal up to date — no pending migrations");
  } else {
    console.log(
      `[migrate] applied ${appliedCount} new migration(s), self-healed ${healedCount} already-pushed migration(s)`,
    );
  }
}

// Apply a single migration in its own transaction. Returns "applied" when its
// statements ran, "healed" when EVERY statement was an already-exists no-op
// (db:push had landed it). A migration with a MIX (some new statements, some
// already-exists) is counted as "applied" — the new statements actually ran.
async function applyOneMigration(
  client: postgres.Sql,
  migration: MigrationMeta,
  migrationsSchema: string,
): Promise<"applied" | "healed"> {
  return client.begin(async (txRaw) => {
    const tx = txRaw as unknown as postgres.Sql;
    const schema = tx(migrationsSchema);
    let ranStatements = 0;
    let healedStatements = 0;

    for (const stmt of migration.sql) {
      // Each statement runs inside its OWN savepoint. postgres.js auto-wraps a
      // failed `tx.unsafe()` in an implicit savepoint but RE-RAISES to the
      // enclosing begin(), which aborts the whole transaction — so a plain
      // try/catch around tx.unsafe() does NOT keep the tx usable (verified
      // against the live DB). An explicit txRaw.savepoint() rolls back only the
      // failed statement and lets the surrounding transaction continue.
      // `savepoint` lives on the `TransactionSql` shape (txRaw), not the
      // `Sql`-re-narrowed handle (which exposes the tagged-template call sig).
      try {
        await txRaw.savepoint(async (spRaw) => {
          const sp = spRaw as unknown as postgres.Sql;
          await sp.unsafe(stmt);
        });
        ranStatements++;
      } catch (err) {
        if (isAlreadyExists(err)) {
          // db:push already created this object — treat the statement as a
          // no-op and continue. We never swallow non-"already-exists" errors,
          // so genuinely-broken DDL still aborts the deploy loudly.
          healedStatements++;
          console.log(
            `[migrate]   ${migration.hash.slice(0, 8)}: statement already applied by db:push (${(err as postgres.PostgresError).code}) — recording as applied`,
          );
        } else {
          throw err;
        }
      }
    }

    await tx`INSERT INTO ${schema}.__drizzle_migrations (hash, created_at) /*// SAFE: schema is a postgres.js identifier fragment; hash and folderMillis on the next line are bound parameters, not request data */
             VALUES (${migration.hash}, ${migration.folderMillis})`;

    return ranStatements === 0 && healedStatements > 0 ? "healed" : "applied";
  }) as Promise<"applied" | "healed">;
}

async function main() {
  const url = process.env.POSTGRES_URL;
  if (!url) {
    throw new Error("POSTGRES_URL is required to run migrations");
  }

  // connect_timeout (seconds): a misconfigured/unreachable POSTGRES_URL must
  // fail fast and loud rather than hang the deploy hook indefinitely inside
  // the first query of recoverTrackingIfNeeded (root cause of nx-sbmjj).
  const client = postgres(url, { max: 1, connect_timeout: 10 });

  await recoverTrackingIfNeeded(client);

  console.log("[migrate] running migrations from ./drizzle ...");
  await selfHealingMigrate(client);
  console.log("[migrate] done");

  await client.end();
  process.exit(0);
}

// Only auto-run when invoked as the entrypoint (bun ./src/migrate.ts). When the
// module is imported (e.g. by migrate.test.ts) we expose the helpers instead.
if (import.meta.main) {
  main().catch((err) => {
    console.error("[migrate] failed:", err);
    process.exit(1);
  });
}
