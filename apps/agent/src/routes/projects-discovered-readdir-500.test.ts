/**
 * agent-route-hardening (task 2.1) — readdir-500 regression suite.
 *
 * Locks the fix from task 1.2: when `readdirSync` throws, GET
 * /projects/discovered MUST return HTTP 500 (a server-side scan failure),
 * NOT HTTP 200 with an empty-but-healthy `{ projects: [] }` body. A 200 here
 * makes a broken scan indistinguishable from a configured-but-empty
 * directory, hiding the failure from clients.
 *
 * Scope note (DEFERRED half excluded)
 * ───────────────────────────────────
 * Task 2.1's "legacy empty-cwd resolves a real cwd" half is DEFERRED
 * (beads:nx-cvyxt — stale premise blocked by the /proc readlink invariant
 * nx-9jz0v) and is intentionally NOT covered here. This file asserts ONLY
 * the readdir-500 behaviour.
 *
 * Why a separate file from projects-discovered-core.test.ts
 * ─────────────────────────────────────────────────────────
 * The core file has ONE readdir-throws case (its Test 3). This file extends
 * coverage to the failure surfaces that test does not exercise:
 *   - the error body shape (`{ error }`, no `projects` key)
 *   - a non-Error throw value (string) still yields 500
 *   - a CACHED scan error is re-served as 500 (cache hit must not downgrade)
 *   - the PAGINATED path (cursor/limit) also returns 500
 *
 * It reuses the shared injectable-fs helpers (no process-global module mocks)
 * from projects-discovered.helpers.ts so it cannot corrupt unrelated suites.
 */

import {
  makeDb,
  makeAgentRow,
  resetMocks,
  mockReaddirSync,
} from "./projects-discovered.helpers";

import { describe, expect, it, beforeEach } from "bun:test";
import {
  handleGetDiscoveredProjects,
  clearDiscoveredProjectsCache,
} from "./projects-discovered";

describe("projects-discovered readdir-500 (agent-route-hardening task 2.1)", () => {
  beforeEach(() => {
    clearDiscoveredProjectsCache();
    resetMocks();
  });

  // ── 1) Error body carries { error }, NOT a healthy-but-empty projects list ──

  it("returns 500 with an { error } body (not { projects: [] }) when readdirSync throws", async () => {
    const db = makeDb([makeAgentRow({ projectsDir: "/home/user/broken" })]);

    mockReaddirSync.mockImplementation(() => {
      throw new Error("EACCES: permission denied, scandir '/home/user/broken'");
    });

    const res = await handleGetDiscoveredProjects(db);
    expect(res.status).toBe(500);

    const body = (await res.json()) as Record<string, unknown>;
    // The failure is surfaced as an error, NOT downgraded to a 200 empty list.
    expect(typeof body.error).toBe("string");
    expect(body.error as string).toContain("EACCES");
    expect("projects" in body).toBe(false);
    expect("truncated" in body).toBe(false);
  });

  // ── 2) Non-Error throw value still yields 500 (String(err) fallback) ────────

  it("returns 500 even when readdirSync throws a non-Error value", async () => {
    const db = makeDb([makeAgentRow({ projectsDir: "/home/user/weird-throw" })]);

    // Some fs failures surface as plain strings / objects rather than Error
    // instances. The handler's `err instanceof Error ? ... : String(err)`
    // branch must still produce a 500 with a string error.
    mockReaddirSync.mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw "ENOTDIR raw string failure";
    });

    const res = await handleGetDiscoveredProjects(db);
    expect(res.status).toBe(500);

    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("ENOTDIR");
  });

  // ── 3) Cached scan error must be re-served as 500 (cache hit ≠ downgrade) ───

  it("re-serves a CACHED readdir error as 500 on the next request (no 200 downgrade)", async () => {
    const db = makeDb([makeAgentRow({ projectsDir: "/home/user/cache-fail" })]);

    let calls = 0;
    mockReaddirSync.mockImplementation(() => {
      calls++;
      throw new Error("ENOENT: no such file or directory, scandir '/home/user/cache-fail'");
    });

    // First request computes + caches the error → 500.
    const first = await handleGetDiscoveredProjects(db);
    expect(first.status).toBe(500);

    // Second request (within the 5s cache TTL) MUST be served from cache and
    // STILL be a 500 — a cache hit must not downgrade a readdir error to 200.
    const second = await handleGetDiscoveredProjects(db);
    expect(second.status).toBe(500);
    const body = (await second.json()) as { error: string };
    expect(body.error).toContain("ENOENT");

    // The second request was served from cache, so readdirSync ran only once.
    expect(calls).toBe(1);
    // The cache age header reflects a cache hit on the second response.
    expect(second.headers.get("X-Cache-Age")).not.toBeNull();
  });

  // ── 4) Paginated path (cursor/limit present) also returns 500 ───────────────

  it("returns 500 on the paginated path (?limit=) when readdirSync throws", async () => {
    const db = makeDb([makeAgentRow({ projectsDir: "/home/user/paginated-fail" })]);

    mockReaddirSync.mockImplementation(() => {
      throw new Error("EIO: i/o error, scandir '/home/user/paginated-fail'");
    });

    // A `limit` query param routes through the paginated branch — its readdir
    // failure must also surface as 500 (the paginated branch has its own
    // not-ok handling that must stay parallel to the legacy branch).
    const url = new URL("http://localhost/projects/discovered?limit=10");
    const res = await handleGetDiscoveredProjects(db, url);
    expect(res.status).toBe(500);

    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.error).toBe("string");
    expect(body.error as string).toContain("EIO");
    // The paginated success shape is { items, nextCursor } — on error neither
    // key should be present.
    expect("items" in body).toBe(false);
    expect("nextCursor" in body).toBe(false);
  });

  // ── 5) Negative control: a HEALTHY empty dir is 200, not 500 ────────────────

  it("returns 200 (not 500) for a genuinely empty-but-readable directory", async () => {
    const db = makeDb([makeAgentRow({ projectsDir: "/home/user/empty-ok" })]);

    // readdirSync succeeds with zero entries — this is the healthy empty case
    // the fix must NOT conflate with a scan failure.
    mockReaddirSync.mockImplementation(() => []);

    const res = await handleGetDiscoveredProjects(db);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { projects: unknown[]; truncated: boolean };
    expect(body.projects).toEqual([]);
    expect(body.truncated).toBe(false);
  });
});
