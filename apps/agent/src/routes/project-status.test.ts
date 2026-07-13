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

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  mock,
  spyOn,
} from "bun:test";

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
  GitEventsResponse,
  GitStatusObject,
  ProjectStatusHistoryResponse,
  ProjectStatusLatestResponse,
} from "@nexus/core";
import {
  tryHandleGitEventsRoute,
  tryHandleProjectStatusRoute,
} from "./project-status";
import * as gitObserver from "../services/git-observer";

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

// ── git-events dispatcher: no-DB match + unknown project ──────────────────
// add-git-status-orbit 4.2. The `git-events` dispatcher mirrors the `status`
// dispatcher shape — a precise 4-segment match, 404 for an unknown project
// before any DB access — so the same no-DB cases apply.

describe("tryHandleGitEventsRoute dispatcher", () => {
  it("returns null when the path is not /projects/:id/git-events", () => {
    const { url, request } = get("/projects/nx/status");
    expect(tryHandleGitEventsRoute(request, url, {} as Db)).toBeNull();
  });

  it("returns null for a non-GET method", () => {
    const href = "http://localhost/projects/nx/git-events";
    const url = new URL(href);
    const request = new Request(href, { method: "PATCH" });
    expect(tryHandleGitEventsRoute(request, url, {} as Db)).toBeNull();
  });

  it("404s an unknown project before touching the DB", async () => {
    fixtureProjects.length = 0; // no registered projects
    const { url, request } = get("/projects/zzz-nope/git-events");
    const result = tryHandleGitEventsRoute(request, url, {} as Db);
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

// ── git-status-orbit serving (PG-gated) ───────────────────────────────────
// add-git-status-orbit 4.2. Two serving surfaces:
//   1. GET /projects/:id/status folds an observer `git` object into the latest
//      payload when observed, and omits the key entirely when unobserved. The
//      200 path requires a project_status_snapshots row (handleGetLatest 404s
//      before folding git when there is no snapshot), so the fold/omit cases
//      are DB-backed. `getObservedGitState` is a module-level in-memory seam;
//      it is stubbed via a restorable `spyOn` (never mock.module — avoids the
//      process-global forward-leak class) so the fold is deterministic without
//      running the real 60s git poll.
//   2. GET /projects/:id/git-events?days=<n> returns the persisted transition
//      history oldest-first, capped at the retention window.

const GIT_SCHEMA = `nx_git_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

const GIT_DDL = `
  CREATE TABLE "project_status_snapshots" (
    "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    "project" text NOT NULL,
    "proposals_unarchived" integer NOT NULL,
    "beads_ready_unlinked" integer NOT NULL,
    "beads_blocked_unlinked" integer NOT NULL,
    "created_at" timestamp with time zone NOT NULL DEFAULT now()
  );

  CREATE TABLE "git_events" (
    "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    "project" text NOT NULL,
    "event_type" text NOT NULL,
    "from_ref" text,
    "to_ref" text,
    "sha" text,
    "created_at" timestamp with time zone NOT NULL DEFAULT now()
  );
`;

let gitAdminSql: ReturnType<typeof createDb>["client"];
let gitScopedClient: ReturnType<typeof createDb>["client"];
let gitDb: Db;

describe.skipIf(!hasPg)(
  "git-status-orbit serving (requires live PG)",
  () => {
    beforeAll(async () => {
      const url = process.env.POSTGRES_URL!;
      const adminHandle = createDb(url);
      gitAdminSql = adminHandle.client;

      await gitAdminSql.unsafe(`CREATE SCHEMA "${GIT_SCHEMA}"`);
      await gitAdminSql.unsafe(`SET search_path TO "${GIT_SCHEMA}", public`);
      await gitAdminSql.unsafe(GIT_DDL);

      const scopedHandle = createDb(url, {
        connection: { search_path: `"${GIT_SCHEMA}",public` },
      });
      gitScopedClient = scopedHandle.client;
      gitDb = scopedHandle.db;

      fixtureProjects.push({ code: "gob", name: "git-orbit", path: "/tmp/gob" });

      const now = Date.now();
      const at = (daysAgo: number) =>
        new Date(now - daysAgo * 86_400_000).toISOString();

      // One snapshot so the latest-status path reaches 200 (the git fold only
      // happens on a 200 response).
      await gitAdminSql.unsafe(
        `INSERT INTO "${GIT_SCHEMA}".project_status_snapshots
           ("project", "proposals_unarchived", "beads_ready_unlinked", "beads_blocked_unlinked", "created_at")
         VALUES ('gob', 5, 0, 0, '${at(0.001)}')`,
      );

      // git_events for "gob": one out-of-window (200d) row that the retention
      // cap must exclude, then three in-window transitions inserted OUT of
      // chronological order so the oldest-first assertion is meaningful.
      await gitAdminSql.unsafe(
        `INSERT INTO "${GIT_SCHEMA}".git_events
           ("project", "event_type", "from_ref", "to_ref", "sha", "created_at")
         VALUES ('gob', 'branch_switch', 'ancient', 'main', NULL, '${at(200)}'),
                ('gob', 'new_commit', NULL, NULL, 'sha-newest', '${at(0.001)}'),
                ('gob', 'branch_switch', 'main', 'feat', NULL, '${at(2)}'),
                ('gob', 'new_commit', NULL, NULL, 'sha-middle', '${at(1)}')`,
      );
    });

    afterAll(async () => {
      fixtureProjects.length = 0;
      try {
        await gitScopedClient.end({ timeout: 5 });
      } finally {
        try {
          await gitAdminSql.unsafe(`DROP SCHEMA IF EXISTS "${GIT_SCHEMA}" CASCADE`);
        } finally {
          await gitAdminSql.end({ timeout: 5 });
        }
      }
    });

    it("folds the observer git object into the latest status when observed", async () => {
      const observed: GitStatusObject = {
        branch: "feat",
        headSha: "abc1234def",
        detached: false,
        dirty: { modified: 2, untracked: 1 },
        observedAt: new Date().toISOString(),
      };
      const spy = spyOn(gitObserver, "getObservedGitState").mockReturnValue(
        observed,
      );
      try {
        const { url, request } = get("/projects/gob/status");
        const response = await tryHandleProjectStatusRoute(request, url, gitDb)!;
        expect(response.status).toBe(200);
        const body = (await response.json()) as ProjectStatusLatestResponse & {
          git?: GitStatusObject;
        };
        expect(body.project).toBe("gob");
        expect(body.git).toEqual(observed);
      } finally {
        spy.mockRestore();
      }
    });

    it("omits the git key entirely when the project is unobserved", async () => {
      const spy = spyOn(gitObserver, "getObservedGitState").mockReturnValue(
        undefined,
      );
      try {
        const { url, request } = get("/projects/gob/status");
        const response = await tryHandleProjectStatusRoute(request, url, gitDb)!;
        expect(response.status).toBe(200);
        const body = (await response.json()) as Record<string, unknown>;
        expect(body.project).toBe("gob");
        expect(body).not.toHaveProperty("git");
      } finally {
        spy.mockRestore();
      }
    });

    it("git-events returns the history oldest-first, capped at the retention window", async () => {
      // Ask for far more days than are retained (90d default); the route caps
      // to the retention window, so the 200-day-old row is excluded.
      const { url, request } = get("/projects/gob/git-events?days=99999");
      const response = await tryHandleGitEventsRoute(request, url, gitDb)!;
      expect(response.status).toBe(200);
      const body = (await response.json()) as GitEventsResponse;

      // Only the three in-window rows; the 200-day-old 'ancient'->'main' row is
      // capped out.
      expect(body.length).toBe(3);
      expect(body.some((e) => e.fromRef === "ancient")).toBe(false);

      // Oldest-first ordering by createdAt.
      const times = body.map((e) => new Date(e.createdAt).getTime());
      expect(times[0]!).toBeLessThan(times[1]!);
      expect(times[1]!).toBeLessThan(times[2]!);
      // t-2d branch_switch, t-1d new_commit, t-now new_commit.
      expect(body[0]!.eventType).toBe("branch_switch");
      expect(body[0]!.toRef).toBe("feat");
      expect(body[1]!.sha).toBe("sha-middle");
      expect(body[2]!.sha).toBe("sha-newest");
    });

    it("git-events returns [] for a known project with no events", async () => {
      fixtureProjects.push({ code: "noev", name: "no-events", path: "/tmp/noev" });
      try {
        const { url, request } = get("/projects/noev/git-events");
        const response = await tryHandleGitEventsRoute(request, url, gitDb)!;
        expect(response.status).toBe(200);
        const body = (await response.json()) as GitEventsResponse;
        expect(body).toEqual([]);
      } finally {
        fixtureProjects.pop();
      }
    });
  },
);
