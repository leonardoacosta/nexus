/**
 * Cursor pagination tests for GET /projects and GET /projects/discovered.
 *
 * Covers:
 * - Paginated caller: 120 items → page 1 (50 + nextCursor) → page 2 (50 +
 *   nextCursor) → page 3 (20, nextCursor: null).
 * - Legacy caller (no cursor/limit): full array shape preserved.
 * - Invalid cursor → 400.
 * - `limit` clamping to [1, 200].
 */

import {
  makeDb,
  dirent,
  makeAgentRow,
  resetMocks,
  mockReaddirSync,
  mockExistsSync,
  mockQueryRecentSessions,
} from "./projects-discovered.helpers";

import { describe, expect, it, beforeEach } from "bun:test";
import {
  handleGetDiscoveredProjects,
  clearDiscoveredProjectsCache,
  type AgentDiscoveredProjectsPaginatedResponse,
  type AgentDiscoveredProjectsResponse,
} from "./projects-discovered";
import { encodeCursor, parseCursor, parseLimit } from "./cursor";

// ── Cursor helper unit tests ────────────────────────────────────────────────

describe("cursor helpers", () => {
  it("parseCursor round-trips encoded values", () => {
    const encoded = encodeCursor("/home/user/dev/repo-50");
    expect(parseCursor(encoded)).toBe("/home/user/dev/repo-50");
  });

  it("parseCursor rejects clearly invalid input", () => {
    expect(parseCursor("!!!not base64!!!")).toBeNull();
    expect(parseCursor("")).toBeNull();
  });

  it("parseLimit clamps to max", () => {
    expect(parseLimit("1000", 50, 200)).toBe(200);
  });

  it("parseLimit clamps to min (1)", () => {
    expect(parseLimit("-5", 50, 200)).toBe(1);
    expect(parseLimit("0", 50, 200)).toBe(1);
  });

  it("parseLimit uses default on null/empty/NaN", () => {
    expect(parseLimit(null, 50, 200)).toBe(50);
    expect(parseLimit("", 50, 200)).toBe(50);
    expect(parseLimit("not-a-number", 50, 200)).toBe(50);
  });
});

// ── Fixture helpers ─────────────────────────────────────────────────────────

/** Install mocks for a projectsDir with `count` git repos named `repo-000`..`repo-119`. */
function mockLargeProjectsDir(count: number): void {
  const dirs = Array.from({ length: count }, (_, i) =>
    dirent(`repo-${String(i).padStart(3, "0")}`, true),
  );
  mockReaddirSync.mockImplementation(
    () => dirs as unknown as ReturnType<typeof import("node:fs").readdirSync>,
  );
  mockExistsSync.mockImplementation((p: string) => p.endsWith("/.git"));
  mockQueryRecentSessions.mockImplementation(() => Promise.resolve([]));
}

// ── Integration tests: GET /projects/discovered ─────────────────────────────

describe("handleGetDiscoveredProjects — cursor pagination", () => {
  beforeEach(() => {
    clearDiscoveredProjectsCache();
    resetMocks();
  });

  it("returns legacy shape when neither cursor nor limit is supplied", async () => {
    const db = makeDb([makeAgentRow({ projectsDir: "/home/user/projects" })]);
    mockLargeProjectsDir(5);

    const res = await handleGetDiscoveredProjects(db);
    expect(res.status).toBe(200);

    const body = (await res.json()) as AgentDiscoveredProjectsResponse;
    expect(Array.isArray(body.projects)).toBe(true);
    expect(body.projects.length).toBe(5);
    expect(body).toHaveProperty("truncated");
    expect(body).toHaveProperty("configured", true);
    expect(body).not.toHaveProperty("items");
    expect(body).not.toHaveProperty("nextCursor");
  });

  it("paginates through 120 projects in three pages of 50/50/20", async () => {
    const db = makeDb([makeAgentRow({ projectsDir: "/home/user/projects" })]);
    mockLargeProjectsDir(120);

    // Page 1
    const url1 = new URL("http://localhost/projects/discovered?limit=50");
    const res1 = await handleGetDiscoveredProjects(db, url1);
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as AgentDiscoveredProjectsPaginatedResponse;
    expect(body1.items.length).toBe(50);
    expect(body1.nextCursor).not.toBeNull();
    expect(typeof body1.nextCursor).toBe("string");
    expect(body1).toHaveProperty("configured", true);
    expect(body1).not.toHaveProperty("projects");
    expect(body1).not.toHaveProperty("truncated");
    // First page covers repo-000..repo-049 (path-sorted)
    expect(body1.items[0]!.name).toBe("repo-000");
    expect(body1.items[49]!.name).toBe("repo-049");

    // Page 2
    const url2 = new URL(`http://localhost/projects/discovered?cursor=${encodeURIComponent(body1.nextCursor!)}&limit=50`);
    const res2 = await handleGetDiscoveredProjects(db, url2);
    const body2 = (await res2.json()) as AgentDiscoveredProjectsPaginatedResponse;
    expect(body2.items.length).toBe(50);
    expect(body2.nextCursor).not.toBeNull();
    expect(body2.items[0]!.name).toBe("repo-050");
    expect(body2.items[49]!.name).toBe("repo-099");

    // Page 3 — final 20, no further nextCursor
    const url3 = new URL(`http://localhost/projects/discovered?cursor=${encodeURIComponent(body2.nextCursor!)}&limit=50`);
    const res3 = await handleGetDiscoveredProjects(db, url3);
    const body3 = (await res3.json()) as AgentDiscoveredProjectsPaginatedResponse;
    expect(body3.items.length).toBe(20);
    expect(body3.nextCursor).toBeNull();
    expect(body3.items[0]!.name).toBe("repo-100");
    expect(body3.items[19]!.name).toBe("repo-119");
  });

  it("returns 400 on invalid cursor without leaking format", async () => {
    const db = makeDb([makeAgentRow({ projectsDir: "/home/user/projects" })]);
    mockLargeProjectsDir(5);

    const url = new URL("http://localhost/projects/discovered?cursor=%21%21not-valid");
    const res = await handleGetDiscoveredProjects(db, url);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid cursor");
    // Ensure we don't leak base64/JSON/path hints
    expect(body.error).not.toMatch(/base64|json|path|uuid/i);
  });

  it("clamps limit=1000 down to 200", async () => {
    const db = makeDb([makeAgentRow({ projectsDir: "/home/user/projects" })]);
    mockLargeProjectsDir(250);

    const url = new URL("http://localhost/projects/discovered?limit=1000");
    const res = await handleGetDiscoveredProjects(db, url);
    expect(res.status).toBe(200);
    const body = (await res.json()) as AgentDiscoveredProjectsPaginatedResponse;
    expect(body.items.length).toBe(200);
    expect(body.nextCursor).not.toBeNull(); // 250 total, 200 returned → more remain
  });

  it("limit=0 clamps up to 1 (min floor)", async () => {
    const db = makeDb([makeAgentRow({ projectsDir: "/home/user/projects" })]);
    mockLargeProjectsDir(10);

    const url = new URL("http://localhost/projects/discovered?limit=0");
    const res = await handleGetDiscoveredProjects(db, url);
    expect(res.status).toBe(200);
    const body = (await res.json()) as AgentDiscoveredProjectsPaginatedResponse;
    expect(body.items.length).toBe(1);
    expect(body.nextCursor).not.toBeNull();
  });
});
