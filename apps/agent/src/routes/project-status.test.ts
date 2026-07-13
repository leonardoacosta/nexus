/**
 * GET /projects/:id/status[?history=<days>] route tests
 * (add-project-status-snapshots 4.2).
 *
 * The config-loader is mocked with a per-file fixture registry (mirrors
 * beads-unlinked.test.ts) so project resolution is deterministic. Unknown-
 * project and dispatcher-match cases run without a DB (the route 404s /
 * returns null before any DB access). The current/history/no-data cases are
 * DB-backed and PG-gated: they skip cleanly when no live Postgres is
 * configured (NEXUS_PG_TESTS=1 + POSTGRES_URL).
 */

import { describe, it, expect, beforeAll, afterAll, mock } from "bun:test";

const fixtureProjects: Array<{ code: string; name: string; path: string }> = [];

mock.module("../services/config-loader", () => ({
  getProjects: () => fixtureProjects.slice(),
  getSettings: () => ({}),
  initConfigLoader: () => {},
  stopConfigLoader: () => {},
}));

import { createDb } from "@nexus/db";
import type { Db } from "@nexus/db";
import type {
  ProjectStatusHistoryResponse,
  ProjectStatusLatestResponse,
} from "@nexus/core";
import { tryHandleProjectStatusRoute } from "./project-status";

import { hasLivePg as hasPg } from "../testing/live-pg";

const get = (path: string) => {
  const href = `http://localhost${path}`;
  const url = new URL(href);
  const request = new Request(href, { method: "GET" });
  return { url, request };
};

// ── No-DB cases: dispatcher match + unknown project ───────────────────────

describe("tryHandleProjectStatusRoute dispatcher", () => {
  it("returns null when the path is not /projects/:id/status", () => {
    const { url, request } = get("/projects/nx");
    expect(tryHandleProjectStatusRoute(request, url, {} as Db)).toBeNull();
  });

  it("returns null for a non-GET method", () => {
    const href = "http://localhost/projects/nx/status";
    const url = new URL(href);
    const request = new Request(href, { method: "PATCH" });
    expect(tryHandleProjectStatusRoute(request, url, {} as Db)).toBeNull();
  });

  it("404s an unknown project before touching the DB", async () => {
    fixtureProjects.length = 0; // no registered projects
    const { url, request } = get("/projects/zzz-nope/status");
    const result = tryHandleProjectStatusRoute(request, url, {} as Db);
    expect(result).not.toBeNull();
    const response = await result!;
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("unknown project");
  });
});

// ── DB-backed cases (PG-gated) ────────────────────────────────────────────

const PS_SCHEMA = `nx_ps_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

const PS_DDL = `
  CREATE TABLE "project_status_snapshots" (
    "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    "project" text NOT NULL,
    "proposals_unarchived" integer NOT NULL,
    "beads_ready_unlinked" integer NOT NULL,
    "beads_blocked_unlinked" integer NOT NULL,
    "created_at" timestamp with time zone NOT NULL DEFAULT now()
  );
`;

let adminSql: ReturnType<typeof createDb>["client"];
let scopedClient: ReturnType<typeof createDb>["client"];
let db: Db;

describe.skipIf(!hasPg)(
  "GET /projects/:id/status (requires live PG)",
  () => {
    beforeAll(async () => {
      const url = process.env.POSTGRES_URL!;
      const adminHandle = createDb(url);
      adminSql = adminHandle.client;

      await adminSql.unsafe(`CREATE SCHEMA "${PS_SCHEMA}"`);
      await adminSql.unsafe(`SET search_path TO "${PS_SCHEMA}", public`);
      await adminSql.unsafe(PS_DDL);

      const scopedHandle = createDb(url, {
        connection: { search_path: `"${PS_SCHEMA}",public` },
      });
      scopedClient = scopedHandle.client;
      db = scopedHandle.db;

      // Register both fixture projects so isKnownProject() resolves them.
      fixtureProjects.push(
        { code: "haz", name: "has-data", path: "/tmp/haz" },
        { code: "emp", name: "empty", path: "/tmp/emp" },
      );

      // "haz" gets three snapshots at t-200d, t-1d, t-now (increasing
      // proposals_unarchived so the latest and ordering are checkable). The
      // 200-day-old row exercises the retention-window cap on ?history.
      const now = Date.now();
      const at = (daysAgo: number) =>
        new Date(now - daysAgo * 86_400_000).toISOString();
      await adminSql.unsafe(
        `INSERT INTO "${PS_SCHEMA}".project_status_snapshots
           ("project", "proposals_unarchived", "beads_ready_unlinked", "beads_blocked_unlinked", "created_at")
         VALUES ('haz', 1, 0, 0, '${at(200)}'),
                ('haz', 2, 1, 0, '${at(1)}'),
                ('haz', 3, 2, 1, '${at(0.001)}')`,
      );
    });

    afterAll(async () => {
      fixtureProjects.length = 0;
      try {
        await scopedClient.end({ timeout: 5 });
      } finally {
        try {
          await adminSql.unsafe(`DROP SCHEMA IF EXISTS "${PS_SCHEMA}" CASCADE`);
        } finally {
          await adminSql.end({ timeout: 5 });
        }
      }
    });

    it("returns 200 with the latest snapshot for a project with data", async () => {
      const { url, request } = get("/projects/haz/status");
      const response = await tryHandleProjectStatusRoute(request, url, db)!;
      expect(response.status).toBe(200);
      const body = (await response.json()) as ProjectStatusLatestResponse;
      expect(body.project).toBe("haz");
      // Latest row is the most recent createdAt -> proposals_unarchived = 3.
      expect(body.proposalsUnarchived).toBe(3);
      expect(body.beadsReadyUnlinked).toBe(2);
      expect(body.beadsBlockedUnlinked).toBe(1);
    });

    it("returns 404 for a known project with no snapshot rows", async () => {
      const { url, request } = get("/projects/emp/status");
      const response = await tryHandleProjectStatusRoute(request, url, db)!;
      expect(response.status).toBe(404);
      const body = (await response.json()) as { error: string };
      expect(body).toHaveProperty("error");
    });

    it("?history returns the series oldest-first, capped at the retention window", async () => {
      // Request far more days than are retained (90d default); the route caps
      // to the retention window, so the 200-day-old row is excluded.
      const { url, request } = get("/projects/haz/status?history=99999");
      const response = await tryHandleProjectStatusRoute(request, url, db)!;
      expect(response.status).toBe(200);
      const body = (await response.json()) as ProjectStatusHistoryResponse;

      // Only the two in-window rows (t-1d, t-now); the 200-day-old row is capped out.
      expect(body.length).toBe(2);

      // Oldest-first ordering by createdAt.
      const times = body.map((r) => new Date(r.createdAt).getTime());
      expect(times[0]!).toBeLessThan(times[1]!);
      expect(body[0]!.proposalsUnarchived).toBe(2); // t-1d row first
      expect(body[1]!.proposalsUnarchived).toBe(3); // t-now row last
    });
  },
);
