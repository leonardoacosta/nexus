import { drizzle } from "drizzle-orm/postgres-js";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

// Recovery path: when an earlier `drizzle-kit push` created the schema without
// populating drizzle.__drizzle_migrations, a subsequent `migrate()` retries
// every migration from idx 0 and crashes on "relation X already exists".
// Detect this state and back-fill the tracking table so migrate() becomes a
// no-op for already-applied migrations. Idempotent in production (skips when
// tracking already has rows or no app schema exists yet).
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
  const migrations = readMigrationFiles({ migrationsFolder: "./drizzle" });
  await client.begin(async (tx) => {
    for (const m of migrations) {
      await tx`INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
               VALUES (${m.hash}, ${m.folderMillis})`;
    }
  });
  console.log(`[migrate] back-filled ${migrations.length} tracking rows`);
}

async function main() {
  const url = process.env.POSTGRES_URL;
  if (!url) {
    throw new Error("POSTGRES_URL is required to run migrations");
  }

  const client = postgres(url, { max: 1 });
  const db = drizzle(client);

  await recoverTrackingIfNeeded(client);

  console.log("[migrate] running migrations from ./drizzle ...");
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("[migrate] done");

  await client.end();
  process.exit(0);
}

main().catch((err) => {
  console.error("[migrate] failed:", err);
  process.exit(1);
});
