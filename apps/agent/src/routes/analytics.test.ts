/**
 * Analytics route tests.
 *
 * The analytics routes mostly return stubs (data in Rust SQLite) or delegate
 * to PostgreSQL queries. Tests verify response shapes and parameter handling.
 * The /analytics/health endpoint requires a live PG and is skipped without
 * POSTGRES_URL.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { createDb } from "@nexus/db";
import type { Db } from "@nexus/db";
import {
  handleAnalyticsHealth,
  handleAnalyticsNotifications,
  handleAnalyticsSpecs,
  handleAnalyticsCredentials,
  handleAnalyticsGit,
  handleAnalyticsLifecycle,
  handleAnalyticsCron,
} from "./analytics";

const hasPg = !!process.env.POSTGRES_URL;

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

    const body = (await response.json()) as { rows: unknown[]; count: number; hours: number };
    expect(body.count).toBe(3);
    expect(body.rows).toHaveLength(3);
    expect(body.hours).toBe(24);
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
});

describe("handleAnalyticsNotifications input validation (no DB)", () => {
  it("rejects NaN hours param", async () => {
    const url = new URL("http://localhost/analytics/notifications?hours=abc");
    const response = await handleAnalyticsNotifications(null as never, url);
    expect(response.status).toBe(400);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("positive");
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
