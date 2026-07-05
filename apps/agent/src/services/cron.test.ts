import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { msUntilDailyAt, msUntilWeeklyAt, pruneCredentialPolls } from "./cron";
import { createDb, credentialPolls, eq } from "@nexus/db";
import type { Db } from "@nexus/db";
import { hasLivePg as hasPg } from "../testing/live-pg";

type Sql = ReturnType<typeof createDb>["client"];

describe("cron scheduling", () => {
  describe("msUntilDailyAt", () => {
    test("returns positive ms for a time later today", () => {
      const ms = msUntilDailyAt(23, 59);
      // Unless it is exactly 23:59, this should be positive.
      expect(ms).toBeGreaterThan(0);
      // Should be less than 24 hours.
      expect(ms).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
    });

    test("returns ms for next day when time has passed", () => {
      // 00:00 has almost certainly passed (tests don't run at midnight).
      // If by some chance it hasn't, the result would still be valid (<24h).
      const ms = msUntilDailyAt(0, 0);
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
    });

    test("schedules for tomorrow when current time equals target", () => {
      // Simulate: if we call msUntilDailyAt with the current hour/minute,
      // the target <= now (seconds/ms make it pass), so it should be ~24h.
      const now = new Date();
      const ms = msUntilDailyAt(now.getHours(), now.getMinutes());

      // Since the function sets seconds/ms to 0, and now has non-zero seconds,
      // target.getTime() <= now.getTime() is true, so it schedules tomorrow.
      // Result should be close to 24 hours (minus a few seconds).
      const twentyThreeHours = 23 * 60 * 60 * 1000;
      const twentyFourHours = 24 * 60 * 60 * 1000;
      expect(ms).toBeGreaterThan(twentyThreeHours);
      expect(ms).toBeLessThanOrEqual(twentyFourHours);
    });

    test("result is always between 0 and 24 hours", () => {
      // Test a variety of times.
      for (let h = 0; h < 24; h += 6) {
        for (let m = 0; m < 60; m += 15) {
          const ms = msUntilDailyAt(h, m);
          expect(ms).toBeGreaterThan(0);
          expect(ms).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
        }
      }
    });
  });

  describe("msUntilWeeklyAt", () => {
    test("returns positive ms for Sunday 09:00", () => {
      const ms = msUntilWeeklyAt(0, 9, 0); // 0 = Sunday
      expect(ms).toBeGreaterThan(0);
      // Should be at most 7 days.
      expect(ms).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);
    });

    test("returns ms within 7 days for any day/time", () => {
      for (let day = 0; day <= 6; day++) {
        const ms = msUntilWeeklyAt(day, 12, 0);
        expect(ms).toBeGreaterThan(0);
        expect(ms).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);
      }
    });

    test("schedules next week when today is the target day and time has passed", () => {
      const now = new Date();
      const currentDay = now.getDay();

      // Use a time that has already passed today (00:00 if not midnight).
      const ms = msUntilWeeklyAt(currentDay, 0, 0);
      // Should be close to 7 days from now (minus a few seconds/minutes for
      // the time already elapsed past midnight).
      const sixDays = 6 * 24 * 60 * 60 * 1000;
      expect(ms).toBeGreaterThan(sixDays);
      expect(ms).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);
    });

    test("returns less than 7 days for a future day this week", () => {
      const now = new Date();
      const currentDay = now.getDay();
      // Pick a day later this week (wrapping around is fine since mod 7).
      const futureDay = (currentDay + 3) % 7;

      const ms = msUntilWeeklyAt(futureDay, 12, 0);
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);
    });
  });
});

// ── [4.2] credential_polls reaper retention (requires live PG) ──────────────
//
// Uses the scratch-schema isolation pattern (see reaper-persistence.test.ts):
// each run creates a unique schema under POSTGRES_URL, builds a minimal
// credentials + credential_polls shape there, pins every pooled connection to
// it via connection.search_path, and drops the schema in teardown. Drives the
// REAL pruneCredentialPolls() query (not a copy) so a retention-window change
// in cron.ts lands via a failing assertion. Skips cleanly without live PG.

const SCHEMA = `nx_cron_polls_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

const DDL = `
  CREATE TABLE "credentials" (
    "id" text PRIMARY KEY,
    "name" text NOT NULL,
    "type" text NOT NULL,
    "status" text NOT NULL DEFAULT 'available',
    "rate_limit_count" integer NOT NULL DEFAULT 0,
    "fingerprint" text NOT NULL DEFAULT '',
    "is_primary" boolean NOT NULL DEFAULT false,
    "created_at" timestamp NOT NULL DEFAULT now(),
    "updated_at" timestamp NOT NULL DEFAULT now()
  );
  CREATE TABLE "credential_polls" (
    "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    "credential_id" text NOT NULL REFERENCES "credentials"("id") ON DELETE CASCADE,
    "fingerprint" text NOT NULL,
    "usage_5h_used" integer,
    "usage_5h_limit" integer,
    "usage_7d_used" integer,
    "usage_7d_limit" integer,
    "usage_5h_reset_at" timestamptz,
    "usage_7d_reset_at" timestamptz,
    "polled_at" timestamptz NOT NULL
  );
`;

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

describe.skipIf(!hasPg)("pruneCredentialPolls (requires live PG)", () => {
  let adminClient: Sql;
  let scopedClient: Sql;
  let db: Db;

  beforeAll(async () => {
    const url = process.env.POSTGRES_URL!;
    const adminHandle = createDb(url);
    adminClient = adminHandle.client;

    await adminClient.unsafe(`CREATE SCHEMA "${SCHEMA}"`);
    await adminClient.unsafe(`SET search_path TO "${SCHEMA}", public`);
    await adminClient.unsafe(DDL);

    const scopedHandle = createDb(url, {
      connection: { search_path: `"${SCHEMA}",public` },
    });
    scopedClient = scopedHandle.client;
    db = scopedHandle.db;

    // FK-parent seed via raw SQL — drizzle's insert would emit JS-default
    // columns (encryption_key_id, etc.) absent from the minimal DDL above.
    await scopedClient.unsafe(
      `INSERT INTO "credentials" (id, name, type, fingerprint, is_primary)
       VALUES ('cred-1', 'primary', 'anthropic', 'fp-1', true)`,
    );
  });

  afterAll(async () => {
    try {
      await scopedClient.end({ timeout: 5 });
    } finally {
      try {
        await adminClient.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      } finally {
        await adminClient.end({ timeout: 5 });
      }
    }
  });

  test("deletes rows older than 30 days and retains newer rows", async () => {
    // Two stale (>30d) rows, two fresh (<30d) rows.
    await db.insert(credentialPolls).values([
      { credentialId: "cred-1", fingerprint: "fp-1", polledAt: daysAgo(45) },
      { credentialId: "cred-1", fingerprint: "fp-1", polledAt: daysAgo(31) },
      { credentialId: "cred-1", fingerprint: "fp-1", polledAt: daysAgo(29) },
      { credentialId: "cred-1", fingerprint: "fp-1", polledAt: daysAgo(1) },
    ]);

    const pruned = await pruneCredentialPolls(db);
    expect(pruned).toBe(2);

    const remaining = await db
      .select({ polledAt: credentialPolls.polledAt })
      .from(credentialPolls)
      .where(eq(credentialPolls.credentialId, "cred-1"));
    expect(remaining).toHaveLength(2);
    // Every surviving row is within the 30-day window.
    const cutoff = daysAgo(30).getTime();
    for (const r of remaining) {
      expect(r.polledAt.getTime()).toBeGreaterThan(cutoff);
    }
  });
});
