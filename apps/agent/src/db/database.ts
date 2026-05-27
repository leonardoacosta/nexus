import { sql } from "drizzle-orm";
import { createDb } from "@nexus/db";
import type { Db } from "@nexus/db";
import { logger } from "@nexus/core/node";

/**
 * Required tables on the agent's hot path. If any of these are missing, the
 * agent will refuse to start — `db_ok` would otherwise lie ("PG handshake
 * succeeded") while every read/write returns 500 (`relation "..." does not
 * exist`).
 *
 * Background: 2026-05-26 outage (`bd show nx-dbame`) — the agent on homelab
 * connected to a freshly-provisioned `nexus` database that had ZERO tables,
 * served `/notifications/send` and `/events` with 500 for seven weeks, and
 * `nx_notify`'s `curl -sf` masked the failure. The startup probe below
 * converts that class of failure into a fast fail-exit with an actionable
 * error message.
 */
export const REQUIRED_TABLES = [
  "sessions",
  "session_events",
  "health_snapshots",
  "notifications",
  // Added 2026-05-27 [nx-fbje2] — drift detector caught this missing post-D&D cleanup
  "credential_swaps",
] as const;

/** Env var that bypasses the schema check — intended ONLY for tests / CI. */
const SKIP_ENV_VAR = "NEXUS_SKIP_SCHEMA_CHECK";

/**
 * Thrown by `verifySchema()` when one or more required tables are missing.
 * Caught in `apps/agent/src/index.ts` and converted to a `process.exit(1)`
 * so the agent never binds :7400 with a broken schema.
 */
export class SchemaIncompleteError extends Error {
  readonly missingTables: readonly string[];
  readonly host: string | null;
  readonly database: string | null;

  constructor(
    missingTables: readonly string[],
    locationHint: { host: string | null; database: string | null },
  ) {
    const location =
      locationHint.host && locationHint.database
        ? `${locationHint.host}/${locationHint.database}`
        : "<unknown>";
    super(
      `Schema verification failed: missing tables [${missingTables.join(", ")}]. ` +
        `The \`${locationHint.database ?? "nexus"}\` database at ${location} ` +
        `exists but Drizzle migrations have not been applied. ` +
        `Run: pnpm --filter @nexus/db db:push (or drizzle-kit push) against ` +
        `POSTGRES_URL before starting the agent. ` +
        `Set ${SKIP_ENV_VAR}=1 to bypass this check (unsafe for production).`,
    );
    this.name = "SchemaIncompleteError";
    this.missingTables = missingTables;
    this.host = locationHint.host;
    this.database = locationHint.database;
  }
}

/**
 * Extract host:port + database name from a POSTGRES_URL without leaking the
 * password. Returns nulls when the URL is missing or unparsable — the caller
 * (error message constructor) tolerates partial info.
 *
 * Postgres URL shape: `postgres://user:password@host:port/dbname?params`.
 * We strip everything left of `@` so the password never reaches the logs.
 */
function describePostgresUrl(url: string | undefined): {
  host: string | null;
  database: string | null;
} {
  if (!url) return { host: null, database: null };
  try {
    // The `URL` parser handles `postgres://` and `postgresql://` schemes.
    const u = new URL(url);
    const host = u.port ? `${u.hostname}:${u.port}` : u.hostname || null;
    // Trim the leading `/` and strip any query/fragment.
    const database = u.pathname ? u.pathname.replace(/^\//, "") || null : null;
    return { host, database };
  } catch {
    return { host: null, database: null };
  }
}

/**
 * Probe each required table with `SELECT to_regclass('<name>')`. Returns the
 * list of tables that resolved to NULL (i.e. don't exist in the current
 * search_path).
 *
 * Why `to_regclass`: it's a single planner-level lookup against pg_class — no
 * row scan, no permission check, no error on missing tables. Cheaper than
 * `SELECT 1 FROM <tbl> LIMIT 0` (which has to acquire a relation lock) and
 * doesn't blow up if the table genuinely doesn't exist.
 */
async function findMissingTables(db: Db): Promise<string[]> {
  const missing: string[] = [];
  for (const table of REQUIRED_TABLES) {
    try {
      // `to_regclass` returns NULL when the relation doesn't exist. We coerce
      // to text so the postgres.js driver hands us a string|null instead of
      // a `regclass` OID — easier to compare against null.
      const result = (await db.execute(
        sql`SELECT to_regclass(${table})::text AS oid`,
      )) as unknown as Array<{ oid: string | null }>;
      const oid = result[0]?.oid ?? null;
      if (oid === null) missing.push(table);
    } catch (err) {
      // A probe failure (timeout, dead pool, permission denied) is treated as
      // "missing" — same caller behaviour, but we log so the operator can
      // distinguish "table absent" from "PG refused".
      logger.warn(
        {
          table,
          error: err instanceof Error ? err.message : String(err),
        },
        "verifySchema: probe failed — treating table as missing",
      );
      missing.push(table);
    }
  }
  return missing;
}

/**
 * Verify the agent's required tables exist on the database the pool is
 * connected to. Throws `SchemaIncompleteError` when any are missing.
 *
 * The check is bypassed when `NEXUS_SKIP_SCHEMA_CHECK=1` — a warning is
 * logged. Intended for CI / fresh-DB test runs; never set this in production.
 *
 * Roundtrip cost: 4 trivial planner-level queries (no row scans). Suitable
 * to run on every `GET /health` request — see `handleHealthGet` in
 * `server-health-handler.ts`.
 */
export async function verifySchema(db: Db): Promise<void> {
  if (process.env[SKIP_ENV_VAR] === "1") {
    logger.warn(
      { envVar: SKIP_ENV_VAR },
      "Schema check bypassed via NEXUS_SKIP_SCHEMA_CHECK; not safe for production",
    );
    return;
  }

  const missing = await findMissingTables(db);
  if (missing.length > 0) {
    throw new SchemaIncompleteError(
      missing,
      describePostgresUrl(process.env.POSTGRES_URL),
    );
  }
}

/**
 * Non-throwing variant for `/health`. Returns `{ schema_ok, missing }` so
 * the route handler can flip `db_ok` to false and surface the missing list
 * without taking down the request.
 *
 * Honors `NEXUS_SKIP_SCHEMA_CHECK` the same way as `verifySchema()` — when
 * the bypass is set, `schema_ok` is reported as `true` (we're explicitly
 * trusting the operator).
 */
export async function checkSchemaForHealth(
  db: Db,
): Promise<{ schema_ok: boolean; missing: readonly string[] }> {
  if (process.env[SKIP_ENV_VAR] === "1") {
    return { schema_ok: true, missing: [] };
  }
  const missing = await findMissingTables(db);
  return { schema_ok: missing.length === 0, missing };
}

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
