/**
 * Analytics route tests.
 *
 * The analytics routes mostly return stubs (data in Rust SQLite) or delegate
 * to PostgreSQL queries. Tests verify response shapes and parameter handling.
 * The /analytics/health endpoint requires a live PG and is skipped without
 * POSTGRES_URL.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  handleAnalyticsHealth,
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

    const body = await response.json();
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

    const body = await response.json();
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

    const body = await response.json();
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

describe("handleAnalyticsHealth input validation (no DB)", () => {
  it("rejects NaN hours param", async () => {
    const url = new URL("http://localhost/analytics/health?hours=not-a-number");
    // Pass a fake db — the function should reject before querying.
    const response = await handleAnalyticsHealth(null as never, url);
    expect(response.status).toBe(400);

    const body = await response.json();
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
