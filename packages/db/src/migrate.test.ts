/**
 * Integration tests for the self-healing migrator (nx-vtzmd).
 *
 * Root cause: the deploy applies schema via `db:push` (live-diff, writes NO
 * drizzle.__drizzle_migrations rows), then the deploy hook runs `db:migrate`
 * (file replay). drizzle's migrator decides what to apply purely by
 * `max(created_at) < folderMillis`, so after db:push lands migration N's
 * objects, file-replay tries to re-create them and crashes (42701 / 42P07).
 *
 * `selfHealingMigrate` catches that "already exists" class, records the
 * migration as applied, and continues — while still applying genuinely-new
 * migrations whose objects do NOT yet exist.
 *
 * These tests run against a REAL Postgres in an isolated schema (search_path).
 * They are skipped when POSTGRES_URL is unset (offline / CI without a DB),
 * mirroring the package's existing real-DB test convention.
 *
 * Verify: `bun test packages/db/src/migrate.test.ts`
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import postgres from "postgres";

import { isAlreadyExists, selfHealingMigrate } from "./migrate";

const URL = process.env.POSTGRES_URL;
const describeDb = URL ? describe : describe.skip;

// A unique schema so the test never collides with the real `public` data.
const TEST_SCHEMA = `nx_migrate_test_${Date.now().toString(36)}`;

/** Write a minimal drizzle migrations folder with the given .sql files. */
function makeMigrationsFolder(
  files: { idx: number; tag: string; when: number; sql: string }[],
): string {
  const dir = mkdtempSync(join(tmpdir(), "nx-migrate-"));
  mkdirSync(join(dir, "meta"), { recursive: true });
  for (const f of files) {
    const name = `${String(f.idx).padStart(4, "0")}_${f.tag}.sql`;
    writeFileSync(join(dir, name), f.sql);
  }
  const journal = {
    version: "7",
    dialect: "postgresql",
    entries: files.map((f) => ({
      idx: f.idx,
      version: "7",
      when: f.when,
      tag: `${String(f.idx).padStart(4, "0")}_${f.tag}`,
      breakpoints: true,
    })),
  };
  writeFileSync(
    join(dir, "meta", "_journal.json"),
    JSON.stringify(journal, null, 2),
  );
  return dir;
}

describe("isAlreadyExists (pure)", () => {
  it("matches the db:push 'already exists' SQLSTATE class", () => {
    expect(isAlreadyExists({ code: "42701" } as never)).toBe(false); // not an Error
    expect(isAlreadyExists(Object.assign(new Error(), { code: "42701" }))).toBe(
      true,
    );
    expect(isAlreadyExists(Object.assign(new Error(), { code: "42P07" }))).toBe(
      true,
    );
    expect(isAlreadyExists(Object.assign(new Error(), { code: "23505" }))).toBe(
      false,
    ); // unique_violation — a REAL error, must NOT be swallowed
    expect(isAlreadyExists(new Error("boom"))).toBe(false);
  });
});

describeDb("selfHealingMigrate (real DB, isolated schema)", () => {
  // Pin every connection in the pool to the isolated schema via search_path so
  // the fixture DDL (widget/gadget/sprocket) lands in TEST_SCHEMA, not public.
  const client = postgres(URL!, {
    max: 1,
    connect_timeout: 10,
    connection: { search_path: `"${TEST_SCHEMA}",public` },
  });

  // The migrations-tracking schema is ALSO TEST_SCHEMA — never the real
  // production "drizzle" schema. This is critical: the real journal's
  // created_at high-watermark (~1.78e12) would otherwise skip every fixture
  // migration as "already covered", and a blanket DELETE would wipe production.
  const MIG_SCHEMA = TEST_SCHEMA;

  beforeAll(async () => {
    await client.unsafe(`CREATE SCHEMA IF NOT EXISTS "${TEST_SCHEMA}"`);
  });

  afterAll(async () => {
    // Dropping TEST_SCHEMA CASCADE removes the fixture tables AND the isolated
    // __drizzle_migrations journal in one shot — zero production blast radius.
    await client.unsafe(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
    await client.end();
  });

  async function clearJournal() {
    await client`DELETE FROM ${client(MIG_SCHEMA)}.__drizzle_migrations`;
  }

  it("heals a PARTIAL journal: object exists (db:push) but row missing -> records, no crash", async () => {
    // Simulate the live bug: migration 0 already journaled+applied, migration 1's
    // object (a column) ALREADY EXISTS because db:push created it, but its journal
    // row is missing. File-replay would crash on 42701; selfHealing must record it.
    const folder = makeMigrationsFolder([
      {
        idx: 0,
        tag: "create_widget",
        when: 1000,
        sql: `CREATE TABLE "widget" ("id" text PRIMARY KEY);`,
      },
      {
        idx: 1,
        tag: "add_vector",
        when: 2000,
        sql: `ALTER TABLE "widget" ADD COLUMN "vector" jsonb;`,
      },
    ]);
    try {
      // First pass applies BOTH cleanly (fresh schema).
      await selfHealingMigrate(client, folder, MIG_SCHEMA);
      const after1 = await client<{ n: number }[]>`
        SELECT count(*)::int AS n FROM ${client(MIG_SCHEMA)}.__drizzle_migrations`;
      expect(after1[0]!.n).toBe(2);

      // Now reproduce the db:push drift: the COLUMN still exists, but delete the
      // journal row for migration 1 (idx>0). max(created_at) drops to 1000, so a
      // naive replay would re-run `ADD COLUMN vector` -> 42701 collision.
      await client`
        DELETE FROM ${client(MIG_SCHEMA)}.__drizzle_migrations WHERE created_at = 2000`;
      const drifted = await client<{ n: number }[]>`
        SELECT count(*)::int AS n FROM ${client(MIG_SCHEMA)}.__drizzle_migrations`;
      expect(drifted[0]!.n).toBe(1);

      // Self-heal: must NOT throw, must re-record the missing row.
      await selfHealingMigrate(client, folder, MIG_SCHEMA);
      const healed = await client<{ hash: string; created_at: string }[]>`
        SELECT hash, created_at::text FROM ${client(MIG_SCHEMA)}.__drizzle_migrations
        ORDER BY created_at`;
      expect(healed.length).toBe(2);
      expect(healed[1]!.created_at).toBe("2000");
    } finally {
      rmSync(folder, { recursive: true, force: true });
      await client`DROP TABLE IF EXISTS "widget" CASCADE`;
      await clearJournal();
    }
  });

  it("is idempotent: a second run is a clean no-op", async () => {
    const folder = makeMigrationsFolder([
      {
        idx: 0,
        tag: "create_gadget",
        when: 1000,
        sql: `CREATE TABLE "gadget" ("id" text PRIMARY KEY);`,
      },
    ]);
    try {
      await selfHealingMigrate(client, folder, MIG_SCHEMA);
      const first = await client<{ n: number }[]>`
        SELECT count(*)::int AS n FROM ${client(MIG_SCHEMA)}.__drizzle_migrations`;
      await selfHealingMigrate(client, folder, MIG_SCHEMA); // no-op
      const second = await client<{ n: number }[]>`
        SELECT count(*)::int AS n FROM ${client(MIG_SCHEMA)}.__drizzle_migrations`;
      expect(second[0]!.n).toBe(first[0]!.n);
    } finally {
      rmSync(folder, { recursive: true, force: true });
      await client`DROP TABLE IF EXISTS "gadget" CASCADE`;
      await clearJournal();
    }
  });

  it("still APPLIES a genuinely-new migration whose objects do NOT exist", async () => {
    const folder = makeMigrationsFolder([
      {
        idx: 0,
        tag: "create_sprocket",
        when: 1000,
        sql: `CREATE TABLE "sprocket" ("id" text PRIMARY KEY);`,
      },
    ]);
    try {
      await selfHealingMigrate(client, folder, MIG_SCHEMA);
      // The table must really exist (not silently skipped).
      const exists = await client<{ n: number }[]>`
        SELECT count(*)::int AS n FROM information_schema.tables
        WHERE table_schema = ${TEST_SCHEMA} AND table_name = 'sprocket'`;
      expect(exists[0]!.n).toBe(1);
    } finally {
      rmSync(folder, { recursive: true, force: true });
      await client`DROP TABLE IF EXISTS "sprocket" CASCADE`;
      await clearJournal();
    }
  });

  it("does NOT swallow a real (non-already-exists) error", async () => {
    // A migration that fails with a genuine error (syntax) must abort, not heal.
    const folder = makeMigrationsFolder([
      {
        idx: 0,
        tag: "broken",
        when: 1000,
        sql: `THIS IS NOT VALID SQL;`,
      },
    ]);
    try {
      let threw = false;
      try {
        await selfHealingMigrate(client, folder, MIG_SCHEMA);
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
      // Nothing recorded.
      const rows = await client<{ n: number }[]>`
        SELECT count(*)::int AS n FROM ${client(MIG_SCHEMA)}.__drizzle_migrations`;
      expect(rows[0]!.n).toBe(0);
    } finally {
      rmSync(folder, { recursive: true, force: true });
      await clearJournal();
    }
  });
});

/**
 * Round-trip regression for `migrate-timestamps-to-timestamptz`.
 *
 * The migration flips 43 bare `timestamp` columns to `timestamp with time zone`
 * via `ALTER COLUMN ... SET DATA TYPE timestamp with time zone` with NO `USING`
 * clause. The proposal's core claim: against a UTC-configured session, that cast
 * reinterprets each naive value at UTC and preserves the same absolute instant,
 * so drizzle's `postgres-js` + `mode:'date'` read returns byte-identical JS
 * `Date` values pre- and post-conversion.
 *
 * This exercises the exact ALTER statement shape the generated migration emits
 * against a real Postgres, on a `sessions`-shaped fixture (startedAt /
 * lastActivity / endedAt), in an isolated schema pinned to UTC.
 */
describeDb("timestamptz conversion round-trip (mode:'date' value stability)", () => {
  const RT_SCHEMA = `nx_tstz_rt_${Date.now().toString(36)}`;
  const rtClient = postgres(URL!, {
    max: 1,
    connect_timeout: 10,
    connection: { search_path: `"${RT_SCHEMA}",public` },
  });
  const rtDb = drizzle(rtClient);

  // Same physical table/columns viewed two ways: bare `timestamp`
  // (pre-migration) vs `timestamptz` (post-migration). drizzle only needs the
  // column names to match — the read decoder differs by `withTimezone`.
  const sessionsPre = pgTable("rt_sessions", {
    id: text("id").primaryKey(),
    startedAt: timestamp("started_at", { mode: "date" }),
    lastActivity: timestamp("last_activity", { mode: "date" }),
    endedAt: timestamp("ended_at", { mode: "date" }),
  });
  const sessionsPost = pgTable("rt_sessions", {
    id: text("id").primaryKey(),
    startedAt: timestamp("started_at", { mode: "date", withTimezone: true }),
    lastActivity: timestamp("last_activity", {
      mode: "date",
      withTimezone: true,
    }),
    endedAt: timestamp("ended_at", { mode: "date", withTimezone: true }),
  });

  beforeAll(async () => {
    await rtClient.unsafe(`CREATE SCHEMA IF NOT EXISTS "${RT_SCHEMA}"`);
    // Pin the session to UTC — mirrors the deploy's UTC-configured session, the
    // condition under which the value-preserving cast holds.
    await rtClient.unsafe(`SET TIME ZONE 'UTC'`);
    await rtClient.unsafe(
      `CREATE TABLE "${RT_SCHEMA}"."rt_sessions" (
         "id" text PRIMARY KEY,
         "started_at" timestamp,
         "last_activity" timestamp,
         "ended_at" timestamp
       )`,
    );
  });

  afterAll(async () => {
    await rtClient.unsafe(`DROP SCHEMA IF EXISTS "${RT_SCHEMA}" CASCADE`);
    await rtClient.end();
  });

  it("bare timestamp -> timestamptz keeps JS Date values byte-identical", async () => {
    const startedAt = new Date("2026-01-02T03:04:05.000Z");
    const lastActivity = new Date("2026-03-14T15:09:26.000Z");
    const endedAt = new Date("2026-07-19T23:59:59.000Z");

    await rtDb
      .insert(sessionsPre)
      .values({ id: "s1", startedAt, lastActivity, endedAt });

    // PRE: read while the columns are still bare `timestamp`.
    const [pre] = await rtDb
      .select()
      .from(sessionsPre)
      .where(eq(sessionsPre.id, "s1"));
    expect(pre).toBeDefined();

    // Apply the EXACT conversion the generated migration emits — no USING clause.
    for (const col of ["started_at", "last_activity", "ended_at"]) {
      await rtClient.unsafe(
        `ALTER TABLE "${RT_SCHEMA}"."rt_sessions" ALTER COLUMN "${col}" SET DATA TYPE timestamp with time zone`,
      );
    }

    // POST: re-read via drizzle mode:'date' now that the columns are timestamptz.
    const [post] = await rtDb
      .select()
      .from(sessionsPost)
      .where(eq(sessionsPost.id, "s1"));
    expect(post).toBeDefined();

    // Primary claim: the type change shifts no value (pre-read === post-read).
    expect(post!.startedAt!.getTime()).toBe(pre!.startedAt!.getTime());
    expect(post!.lastActivity!.getTime()).toBe(pre!.lastActivity!.getTime());
    expect(post!.endedAt!.getTime()).toBe(pre!.endedAt!.getTime());

    // Stronger: both agree with the originally-inserted absolute instants.
    expect(post!.startedAt!.getTime()).toBe(startedAt.getTime());
    expect(post!.lastActivity!.getTime()).toBe(lastActivity.getTime());
    expect(post!.endedAt!.getTime()).toBe(endedAt.getTime());
  });
});
