/**
 * Analytics route tests.
 *
 * The analytics routes mostly return stubs (data in Rust SQLite) or delegate
 * to PostgreSQL queries. Tests verify response shapes and parameter handling.
 * The /analytics/health endpoint requires a live PG and is skipped without
 * POSTGRES_URL.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createDb } from "@nexus/db";
import type { Db } from "@nexus/db";
import {
  handleAnalyticsHealth,
  handleAnalyticsNotifications,
  handleAnalyticsNotificationsSummary,
  handleAnalyticsSpecs,
  handleAnalyticsCredentials,
  handleAnalyticsGit,
  handleAnalyticsLifecycle,
  handleAnalyticsCron,
  encodeCursor,
} from "./analytics";
import { audioPathFor, audioDir } from "../notifications/audio-store";

import { hasLivePg as hasPg } from "../testing/live-pg";

// ---------------------------------------------------------------------------
// Stub endpoints (no DB required)
// ---------------------------------------------------------------------------

describe("handleAnalyticsSpecs (stub)", () => {
  it("returns 200 with empty snapshots array", async () => {
    const url = new URL("http://localhost/analytics/specs");
    const response = await handleAnalyticsSpecs(null as never, url);
    expect(response.status).toBe(200);

    const body = (await response.json()) as { snapshots: unknown[] };
    expect(body).toHaveProperty("snapshots");
    expect(body.snapshots).toEqual([]);
  });

  it("accepts project and days query params without error", async () => {
    const url = new URL("http://localhost/analytics/specs?project=nx&days=30");
    const response = await handleAnalyticsSpecs(null as never, url);
    expect(response.status).toBe(200);
  });
});

describe("handleAnalyticsCredentials (stub)", () => {
  it("returns 200 with empty polls and swaps arrays", async () => {
    const url = new URL("http://localhost/analytics/credentials");
    const response = await handleAnalyticsCredentials(null as never, url);
    expect(response.status).toBe(200);

    const body = (await response.json()) as { polls: unknown[]; swaps: unknown[] };
    expect(body).toHaveProperty("polls");
    expect(body).toHaveProperty("swaps");
    expect(body.polls).toEqual([]);
    expect(body.swaps).toEqual([]);
  });

  it("accepts hours query param without error", async () => {
    const url = new URL("http://localhost/analytics/credentials?hours=48");
    const response = await handleAnalyticsCredentials(null as never, url);
    expect(response.status).toBe(200);
  });
});

describe("handleAnalyticsGit (stub)", () => {
  it("returns 200 with empty JSON array", async () => {
    const url = new URL("http://localhost/analytics/git");
    const response = await handleAnalyticsGit(null as never, url);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toEqual([]);
  });

  it("accepts project and limit query params", async () => {
    const url = new URL("http://localhost/analytics/git?project=nx&limit=50");
    const response = await handleAnalyticsGit(null as never, url);
    expect(response.status).toBe(200);
  });
});

describe("handleAnalyticsLifecycle (stub)", () => {
  it("returns 200 with empty JSON array", async () => {
    const url = new URL("http://localhost/analytics/lifecycle");
    const response = await handleAnalyticsLifecycle(null as never, url);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toEqual([]);
  });

  it("accepts limit query param", async () => {
    const url = new URL("http://localhost/analytics/lifecycle?limit=25");
    const response = await handleAnalyticsLifecycle(null as never, url);
    expect(response.status).toBe(200);
  });
});

describe("handleAnalyticsCron (stub)", () => {
  it("returns 200 with empty JSON array", async () => {
    const url = new URL("http://localhost/analytics/cron");
    const response = await handleAnalyticsCron(null as never, url);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toEqual([]);
  });

  it("accepts job and limit query params", async () => {
    const url = new URL("http://localhost/analytics/cron?job=maintain&limit=10");
    const response = await handleAnalyticsCron(null as never, url);
    expect(response.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// handleAnalyticsHealth (requires PG)
// ---------------------------------------------------------------------------

describe.skipIf(!hasPg)("handleAnalyticsHealth (requires live PG)", () => {
  let db: import("@nexus/db").Db;

  beforeAll(async () => {
    const { openDatabase } = await import("../db/database");
    db = await openDatabase();
  });

  afterAll(async () => {
    // Drizzle PG connections don't need explicit close in test context.
  });

  it("returns 200 with JSON array for default 24h window", async () => {
    const url = new URL("http://localhost/analytics/health");
    const response = await handleAnalyticsHealth(db, url);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it("respects ?hours=1 query param", async () => {
    const url = new URL("http://localhost/analytics/health?hours=1");
    const response = await handleAnalyticsHealth(db, url);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it("returns 400 for invalid hours param", async () => {
    const url = new URL("http://localhost/analytics/health?hours=abc");
    const response = await handleAnalyticsHealth(db, url);
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body).toHaveProperty("error");
  });

  it("returns 400 for negative hours", async () => {
    const url = new URL("http://localhost/analytics/health?hours=-5");
    const response = await handleAnalyticsHealth(db, url);
    expect(response.status).toBe(400);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("positive");
  });

  it("returns 400 for zero hours", async () => {
    const url = new URL("http://localhost/analytics/health?hours=0");
    const response = await handleAnalyticsHealth(db, url);
    expect(response.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// handleAnalyticsHealth — validation tests (no DB needed)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// handleAnalyticsNotifications (requires PG)
//
// Spec: analytics-query-and-tts-synthesis. Seeds three rows across two projects
// and two statuses, then verifies the route's hours / project / status filters.
// ---------------------------------------------------------------------------

const AN_SCHEMA = `nx_an_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

const AN_DDL = `
  CREATE TABLE "notifications" (
    "id" text PRIMARY KEY NOT NULL,
    "channel" text NOT NULL,
    "title" text NOT NULL,
    "body" text NOT NULL,
    "project" text,
    "agent_id" text,
    "priority" text NOT NULL DEFAULT 'normal',
    "status" text NOT NULL DEFAULT 'queued',
    "severity" text NOT NULL DEFAULT 'info',
    "delivery_state" text NOT NULL DEFAULT 'pending',
    "audio_path" text,
    "voice_used" text,
    "created_at" timestamp NOT NULL,
    "sent_at" timestamp
  );
`;

describe.skipIf(!hasPg)("handleAnalyticsNotifications (requires live PG)", () => {
  let adminClient: ReturnType<typeof createDb>["client"];
  let scopedClient: ReturnType<typeof createDb>["client"];
  let db: Db;

  beforeAll(async () => {
    const url = process.env.POSTGRES_URL!;
    const adminHandle = createDb(url);
    adminClient = adminHandle.client;

    await adminClient.unsafe(`CREATE SCHEMA "${AN_SCHEMA}"`);
    await adminClient.unsafe(`SET search_path TO "${AN_SCHEMA}", public`);
    await adminClient.unsafe(AN_DDL);

    const scopedHandle = createDb(url, {
      connection: { search_path: `"${AN_SCHEMA}",public` },
    });
    scopedClient = scopedHandle.client;
    db = scopedHandle.db;
  });

  afterAll(async () => {
    try {
      await scopedClient.end({ timeout: 5 });
    } finally {
      try {
        await adminClient.unsafe(`DROP SCHEMA IF EXISTS "${AN_SCHEMA}" CASCADE`);
      } finally {
        await adminClient.end({ timeout: 5 });
      }
    }
  });

  beforeEach(async () => {
    // Truncate + reseed three rows across two projects and two statuses.
    // All three rows fall inside the default 24h window.
    await scopedClient.unsafe(`DELETE FROM "${AN_SCHEMA}"."notifications"`);
    const now = new Date();
    const within24h = new Date(now.getTime() - 60 * 60 * 1000); // 1h ago
    const within24hAlt = new Date(now.getTime() - 30 * 60 * 1000); // 30m ago

    await adminClient.unsafe(`
      INSERT INTO "${AN_SCHEMA}".notifications
        ("id", "channel", "title", "body", "project", "status", "created_at")
      VALUES
        ('an-1', 'desktop', 'Build OK foo', 'foo body', 'foo', 'delivered', '${within24h.toISOString()}'),
        ('an-2', 'desktop', 'Build dropped foo', 'foo dropped', 'foo', 'suppressed', '${within24hAlt.toISOString()}'),
        ('an-3', 'tts', 'Build OK bar', 'bar body', 'bar', 'delivered', '${now.toISOString()}')
    `);
  });

  it("?hours=24 returns all three seeded rows", async () => {
    const url = new URL("http://localhost/analytics/notifications?hours=24");
    const response = await handleAnalyticsNotifications(db, url);
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      rows: unknown[];
      count: number;
      filters: { hours: number };
    };
    expect(body.count).toBe(3);
    expect(body.rows).toHaveLength(3);
    expect(body.filters.hours).toBe(24);
  });

  it("?project=foo returns only the foo rows", async () => {
    const url = new URL("http://localhost/analytics/notifications?project=foo");
    const response = await handleAnalyticsNotifications(db, url);
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      rows: Array<{ id: string; project: string }>;
      count: number;
      filters: { project: string | null; status: string | null };
    };
    expect(body.count).toBe(2);
    expect(body.rows.every((r) => r.project === "foo")).toBe(true);
    expect(body.filters.project).toBe("foo");
  });

  it("?status=delivered returns only the delivered rows", async () => {
    const url = new URL("http://localhost/analytics/notifications?status=delivered");
    const response = await handleAnalyticsNotifications(db, url);
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      rows: Array<{ id: string; status: string }>;
      count: number;
      filters: { project: string | null; status: string | null };
    };
    expect(body.count).toBe(2);
    expect(body.rows.every((r) => r.status === "delivered")).toBe(true);
    expect(body.filters.status).toBe("delivered");
  });

  it("combined ?project=foo&status=delivered returns the single matching row", async () => {
    const url = new URL(
      "http://localhost/analytics/notifications?project=foo&status=delivered",
    );
    const response = await handleAnalyticsNotifications(db, url);
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      rows: Array<{ id: string; project: string; status: string }>;
      count: number;
    };
    expect(body.count).toBe(1);
    expect(body.rows[0]!.id).toBe("an-1");
    expect(body.rows[0]!.project).toBe("foo");
    expect(body.rows[0]!.status).toBe("delivered");
  });

  it("returns 200 with empty rows when no row matches", async () => {
    const url = new URL("http://localhost/analytics/notifications?project=does-not-exist");
    const response = await handleAnalyticsNotifications(db, url);
    expect(response.status).toBe(200);

    const body = (await response.json()) as { rows: unknown[]; count: number };
    expect(body.count).toBe(0);
    expect(body.rows).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Backward-compat envelope shape (analytics-pagination-cursor task 4)
  //
  // The new envelope MUST include `rows`, `next_cursor`, `has_more`, `count`,
  // `filters` — and `hours` MUST live under `filters`, NOT at the top level.
  // Swift NetworkClient decoder ships in a follow-up; this test pins the
  // wire shape so future drift surfaces immediately.
  // -------------------------------------------------------------------------

  it("backward-compat: no-param request returns full envelope with hours under filters", async () => {
    const url = new URL("http://localhost/analytics/notifications");
    const response = await handleAnalyticsNotifications(db, url);
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    // New envelope keys
    expect(body).toHaveProperty("rows");
    expect(body).toHaveProperty("next_cursor");
    expect(body).toHaveProperty("has_more");
    expect(body).toHaveProperty("count");
    expect(body).toHaveProperty("filters");
    // hours moved INTO filters, not at top level
    expect(body.hours).toBeUndefined();
    const filters = body.filters as { hours: number; project: string | null; status: string | null };
    expect(filters.hours).toBe(24);
    expect(filters.project).toBeNull();
    expect(filters.status).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Pagination + limit scenarios (analytics-pagination-cursor task 1)
  // -------------------------------------------------------------------------

  it("limit boundary: ?limit=500 accepted", async () => {
    const url = new URL("http://localhost/analytics/notifications?limit=500");
    const response = await handleAnalyticsNotifications(db, url);
    expect(response.status).toBe(200);
  });

  it("limit boundary: ?limit=0 rejected with 400", async () => {
    const url = new URL("http://localhost/analytics/notifications?limit=0");
    const response = await handleAnalyticsNotifications(db, url);
    expect(response.status).toBe(400);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("limit");
  });

  it("limit boundary: ?limit=501 rejected with 400", async () => {
    const url = new URL("http://localhost/analytics/notifications?limit=501");
    const response = await handleAnalyticsNotifications(db, url);
    expect(response.status).toBe(400);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("limit");
  });

  it("single page: next_cursor is null when results fit in one page", async () => {
    // Only 3 seeded rows; default limit 50 => everything fits.
    const url = new URL("http://localhost/analytics/notifications");
    const response = await handleAnalyticsNotifications(db, url);
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      next_cursor: string | null;
      has_more: boolean;
      count: number;
    };
    expect(body.next_cursor).toBeNull();
    expect(body.has_more).toBe(false);
    expect(body.count).toBe(3);
  });

  it("multi-page round-trip: 130 rows fetched across 3 pages of 50, all ids unique", async () => {
    // Seed 130 rows with strictly decreasing created_at so keyset order is
    // deterministic. Wipe the default seed first.
    await scopedClient.unsafe(`DELETE FROM "${AN_SCHEMA}"."notifications"`);
    const now = Date.now();
    const values: string[] = [];
    for (let i = 0; i < 130; i++) {
      // 1 second apart so timestamps are unique
      const ts = new Date(now - (i + 1) * 1000).toISOString();
      values.push(
        `('rt-${String(i).padStart(3, "0")}', 'desktop', 'rt ${i}', 'body', 'p', 'delivered', '${ts}')`,
      );
    }
    await adminClient.unsafe(`
      INSERT INTO "${AN_SCHEMA}".notifications
        ("id", "channel", "title", "body", "project", "status", "created_at")
      VALUES ${values.join(",")}
    `);

    type Page = {
      rows: Array<{ id: string }>;
      next_cursor: string | null;
      has_more: boolean;
      count: number;
    };

    const allIds = new Set<string>();
    let cursor: string | null = null;
    let pagesFetched = 0;
    let totalRows = 0;

    for (let page = 0; page < 5; page++) {
      const u = new URL("http://localhost/analytics/notifications?limit=50");
      if (cursor) u.searchParams.set("cursor", cursor);
      const response = await handleAnalyticsNotifications(db, u);
      expect(response.status).toBe(200);
      const body = (await response.json()) as Page;
      pagesFetched++;
      totalRows += body.count;
      for (const r of body.rows) {
        // No row may appear twice across pages.
        expect(allIds.has(r.id)).toBe(false);
        allIds.add(r.id);
      }
      if (!body.has_more) break;
      cursor = body.next_cursor;
      expect(cursor).not.toBeNull();
    }

    expect(pagesFetched).toBe(3);
    expect(totalRows).toBe(130);
    expect(allIds.size).toBe(130);
  });

  it("combined filter + cursor: ?project + ?status preserved across pages", async () => {
    // Wipe + seed 120 rows split: 60 (oo, delivered), 60 (oo, suppressed)
    await scopedClient.unsafe(`DELETE FROM "${AN_SCHEMA}"."notifications"`);
    const now = Date.now();
    const values: string[] = [];
    for (let i = 0; i < 60; i++) {
      const tsA = new Date(now - (i + 1) * 1000).toISOString();
      values.push(
        `('fc-d-${String(i).padStart(3, "0")}', 'desktop', 't', 'b', 'oo', 'delivered', '${tsA}')`,
      );
      const tsB = new Date(now - (i + 1) * 1000 - 500).toISOString();
      values.push(
        `('fc-s-${String(i).padStart(3, "0")}', 'desktop', 't', 'b', 'oo', 'suppressed', '${tsB}')`,
      );
    }
    await adminClient.unsafe(`
      INSERT INTO "${AN_SCHEMA}".notifications
        ("id", "channel", "title", "body", "project", "status", "created_at")
      VALUES ${values.join(",")}
    `);

    type Page = {
      rows: Array<{ id: string; project: string; status: string }>;
      next_cursor: string | null;
      has_more: boolean;
      count: number;
      filters: { project: string | null; status: string | null };
    };

    // First page with filters
    const u1 = new URL(
      "http://localhost/analytics/notifications?project=oo&status=delivered&limit=25",
    );
    const r1 = await handleAnalyticsNotifications(db, u1);
    const p1 = (await r1.json()) as Page;
    expect(p1.count).toBe(25);
    expect(p1.has_more).toBe(true);
    expect(p1.filters.project).toBe("oo");
    expect(p1.filters.status).toBe("delivered");
    expect(p1.rows.every((r) => r.project === "oo" && r.status === "delivered")).toBe(true);

    // Follow cursor — filters must still apply (no "suppressed" rows bleed in)
    const u2 = new URL(
      "http://localhost/analytics/notifications?project=oo&status=delivered&limit=25",
    );
    u2.searchParams.set("cursor", p1.next_cursor!);
    const r2 = await handleAnalyticsNotifications(db, u2);
    const p2 = (await r2.json()) as Page;
    expect(p2.filters.project).toBe("oo");
    expect(p2.filters.status).toBe("delivered");
    expect(p2.rows.every((r) => r.project === "oo" && r.status === "delivered")).toBe(true);
    // No id overlap with page 1
    const ids1 = new Set(p1.rows.map((r) => r.id));
    expect(p2.rows.every((r) => !ids1.has(r.id))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Row payload: audio_available + voice_used (analytics-pagination-cursor
  // task 3). Manipulates the on-disk audio cache via NEXUS_CONFIG_DIR — must
  // be set by the test harness BEFORE these tests run (we set it in beforeAll
  // for this group only via process.env).
  // -------------------------------------------------------------------------

  describe("row payload: audio_available + voice_used", () => {
    let prevConfigDir: string | undefined;
    let isolatedDir: string;

    beforeAll(() => {
      prevConfigDir = process.env.NEXUS_CONFIG_DIR;
      isolatedDir = `/tmp/nx-an-audio-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      process.env.NEXUS_CONFIG_DIR = isolatedDir;
      mkdirSync(audioDir(), { recursive: true });
    });

    afterAll(() => {
      if (prevConfigDir === undefined) delete process.env.NEXUS_CONFIG_DIR;
      else process.env.NEXUS_CONFIG_DIR = prevConfigDir;
    });

    beforeEach(async () => {
      await scopedClient.unsafe(`DELETE FROM "${AN_SCHEMA}"."notifications"`);
      const now = new Date().toISOString();
      // Row a: audio_path set + file present on disk -> available=true
      // Row b: audio_path = NULL -> available=false, voice null
      // Row c: audio_path set but file pruned -> available=false, voice_used echoes column
      await adminClient.unsafe(`
        INSERT INTO "${AN_SCHEMA}".notifications
          ("id", "channel", "title", "body", "project", "status", "audio_path", "voice_used", "created_at")
        VALUES
          ('rp-a', 'tts', 't', 'b', 'p', 'delivered', '/anywhere/rp-a.mp3', 'voice-aaa', '${now}'),
          ('rp-b', 'desktop', 't', 'b', 'p', 'delivered', NULL, NULL, '${now}'),
          ('rp-c', 'tts', 't', 'b', 'p', 'delivered', '/anywhere/rp-c.mp3', 'voice-ccc', '${now}')
      `);

      // Materialize the on-disk audio file for row a; ensure row c's file is
      // absent (it MAY or may not exist from a prior test — unlink defensively).
      mkdirSync(audioDir(), { recursive: true });
      writeFileSync(audioPathFor("rp-a"), Buffer.from([0xff, 0xfb])); // tiny MP3-like
      const cPath = audioPathFor("rp-c");
      if (existsSync(cPath)) unlinkSync(cPath);
    });

    afterAll(() => {
      // Best-effort cleanup of the row-a file.
      try {
        unlinkSync(audioPathFor("rp-a"));
      } catch {
        // ignore
      }
    });

    it("(a) audio_path set + file present -> audio_available true, voice_used echoes", async () => {
      const url = new URL("http://localhost/analytics/notifications?project=p");
      const response = await handleAnalyticsNotifications(db, url);
      expect(response.status).toBe(200);

      const body = (await response.json()) as {
        rows: Array<{ id: string; audio_available: boolean; voice_used: string | null }>;
      };
      const a = body.rows.find((r) => r.id === "rp-a");
      expect(a).toBeDefined();
      expect(a!.audio_available).toBe(true);
      expect(a!.voice_used).toBe("voice-aaa");
    });

    it("(b) audio_path NULL -> audio_available false, voice_used null", async () => {
      const url = new URL("http://localhost/analytics/notifications?project=p");
      const response = await handleAnalyticsNotifications(db, url);
      const body = (await response.json()) as {
        rows: Array<{ id: string; audio_available: boolean; voice_used: string | null }>;
      };
      const b = body.rows.find((r) => r.id === "rp-b");
      expect(b).toBeDefined();
      expect(b!.audio_available).toBe(false);
      expect(b!.voice_used).toBeNull();
    });

    it("(c) audio_path set but file pruned -> audio_available false, voice_used echoes", async () => {
      const url = new URL("http://localhost/analytics/notifications?project=p");
      const response = await handleAnalyticsNotifications(db, url);
      const body = (await response.json()) as {
        rows: Array<{ id: string; audio_available: boolean; voice_used: string | null }>;
      };
      const c = body.rows.find((r) => r.id === "rp-c");
      expect(c).toBeDefined();
      expect(c!.audio_available).toBe(false);
      expect(c!.voice_used).toBe("voice-ccc");
    });
  });

  it("summary: by_title groups repeated (title, project) pairs and orders by count desc", async () => {
    // Insert 2 more "Build OK foo" rows so that title now has 3 occurrences
    // total (an-1 + these 2), while "Build OK bar" and "Build dropped foo"
    // stay at 1 each.
    const now = new Date();
    await adminClient.unsafe(`
      INSERT INTO "${AN_SCHEMA}".notifications
        ("id", "channel", "title", "body", "project", "status", "created_at")
      VALUES
        ('an-4', 'desktop', 'Build OK foo', 'foo body 2', 'foo', 'delivered', '${now.toISOString()}'),
        ('an-5', 'desktop', 'Build OK foo', 'foo body 3', 'foo', 'delivered', '${now.toISOString()}')
    `);

    const url = new URL("http://localhost/analytics/notifications/summary?hours=24");
    const response = await handleAnalyticsNotificationsSummary(db, url);
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      window_hours: number;
      by_title: Array<{ title: string; project: string | null; count: number }>;
      by_hour: Array<{ hour: number; count: number }>;
    };
    expect(body.window_hours).toBe(24);
    expect(body.by_title[0]).toEqual({ title: "Build OK foo", project: "foo", count: 3 });
    expect(body.by_title).toHaveLength(3); // 3 distinct (title, project) pairs total
    expect(body.by_hour).toHaveLength(24); // always exactly 24 entries
    // Boundary-safe invariant: total count across all 24 hour buckets must
    // equal the total row count in the window (5 seeded rows), regardless of
    // which specific hour-of-day buckets they fall into. Do NOT assert a
    // specific single non-zero hour here — an-1 is seeded 1 hour before
    // `now` (see beforeEach above), which is ALWAYS a different hour-of-day
    // than `now` (never the same bucket), so "all rows share one hour" is
    // never a valid assumption for this fixture.
    const totalByHour = body.by_hour.reduce((sum, h) => sum + h.count, 0);
    expect(totalByHour).toBe(5);
    // Every bucket count must be non-negative and the array must stay
    // sorted by hour 0-23 (zero-filled shape contract).
    body.by_hour.forEach((h, i) => expect(h.hour).toBe(i));
  });

  it("summary: respects ?limit=", async () => {
    const url = new URL("http://localhost/analytics/notifications/summary?hours=24&limit=1");
    const response = await handleAnalyticsNotificationsSummary(db, url);
    expect(response.status).toBe(200);

    const body = (await response.json()) as { by_title: unknown[] };
    expect(body.by_title).toHaveLength(1);
  });
});

describe("handleAnalyticsNotifications input validation (no DB)", () => {
  it("rejects NaN hours param", async () => {
    const url = new URL("http://localhost/analytics/notifications?hours=abc");
    const response = await handleAnalyticsNotifications(null as never, url);
    expect(response.status).toBe(400);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("positive");
  });

  // ---------------------------------------------------------------------------
  // Cursor validation scenarios (analytics-pagination-cursor task 2).
  //
  // Each malformed cursor MUST return HTTP 400 and an `error` field that
  // names the failure mode. parseCursor returns the exact reason string the
  // route propagates, so we assert against the documented taxonomy:
  //   - "cursor: malformed base64"
  //   - "cursor: missing field 'created_at'"
  //   - "cursor: created_at must be ISO-8601 string"
  // ---------------------------------------------------------------------------

  it("rejects malformed base64 cursor with 400", async () => {
    const url = new URL("http://localhost/analytics/notifications?cursor=not-base64!!");
    const response = await handleAnalyticsNotifications(null as never, url);
    expect(response.status).toBe(400);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("cursor");
    expect(body.error).toContain("malformed base64");
  });

  it("rejects valid base64 of non-JSON with 400", async () => {
    // base64url("not json") — decodes cleanly, fails JSON parse.
    const token = Buffer.from("not json", "utf8").toString("base64url");
    const url = new URL(
      `http://localhost/analytics/notifications?cursor=${encodeURIComponent(token)}`,
    );
    const response = await handleAnalyticsNotifications(null as never, url);
    expect(response.status).toBe(400);

    const body = (await response.json()) as { error: string };
    // parseCursor folds "JSON parse fail after base64 decode" into the
    // malformed-base64 bucket (see analytics.ts:118-120).
    expect(body.error).toContain("cursor");
    expect(body.error).toContain("malformed base64");
  });

  it("rejects cursor missing the created_at field with 400", async () => {
    const token = Buffer.from(JSON.stringify({ id: "abc" }), "utf8").toString("base64url");
    const url = new URL(
      `http://localhost/analytics/notifications?cursor=${encodeURIComponent(token)}`,
    );
    const response = await handleAnalyticsNotifications(null as never, url);
    expect(response.status).toBe(400);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("cursor");
    expect(body.error).toContain("created_at");
  });

  it("rejects cursor with wrong created_at field type with 400", async () => {
    const token = Buffer.from(
      JSON.stringify({ created_at: 12345, id: "abc" }),
      "utf8",
    ).toString("base64url");
    const url = new URL(
      `http://localhost/analytics/notifications?cursor=${encodeURIComponent(token)}`,
    );
    const response = await handleAnalyticsNotifications(null as never, url);
    expect(response.status).toBe(400);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("cursor");
    expect(body.error).toContain("ISO-8601");
  });

  it("encodeCursor + parseCursor round-trip is accepted by the route", async () => {
    // Sanity check that valid cursors do NOT hit the 400 branch.
    const token = encodeCursor({
      created_at: new Date("2026-01-01T00:00:00.000Z"),
      id: "abc",
    });
    const url = new URL(
      `http://localhost/analytics/notifications?cursor=${encodeURIComponent(token)}`,
    );
    const response = await handleAnalyticsNotifications(null as never, url);
    // Without a db this will 500 on the actual query attempt — but it must
    // NOT 400 on cursor validation. Accept either 500 (no PG) or 200 (PG up).
    expect(response.status).not.toBe(400);
  });
});

describe("handleAnalyticsNotificationsSummary input validation (no DB)", () => {
  it("rejects hours=0", async () => {
    const url = new URL("http://localhost/analytics/notifications/summary?hours=0");
    const response = await handleAnalyticsNotificationsSummary(null as never, url);
    expect(response.status).toBe(400);
  });

  it("rejects limit=0", async () => {
    const url = new URL("http://localhost/analytics/notifications/summary?limit=0");
    const response = await handleAnalyticsNotificationsSummary(null as never, url);
    expect(response.status).toBe(400);
  });

  it("rejects limit > 100", async () => {
    const url = new URL("http://localhost/analytics/notifications/summary?limit=101");
    const response = await handleAnalyticsNotificationsSummary(null as never, url);
    expect(response.status).toBe(400);
  });
});

describe("handleAnalyticsHealth input validation (no DB)", () => {
  it("rejects NaN hours param", async () => {
    const url = new URL("http://localhost/analytics/health?hours=not-a-number");
    // Pass a fake db — the function should reject before querying.
    const response = await handleAnalyticsHealth(null as never, url);
    expect(response.status).toBe(400);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("positive number");
  });

  it("rejects negative hours", async () => {
    const url = new URL("http://localhost/analytics/health?hours=-10");
    const response = await handleAnalyticsHealth(null as never, url);
    expect(response.status).toBe(400);
  });

  it("rejects zero hours", async () => {
    const url = new URL("http://localhost/analytics/health?hours=0");
    const response = await handleAnalyticsHealth(null as never, url);
    expect(response.status).toBe(400);
  });
});
