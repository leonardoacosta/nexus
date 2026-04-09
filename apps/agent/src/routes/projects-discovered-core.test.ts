/**
 * handleGetDiscoveredProjects core tests — agent lookup, empty dir, errors,
 * truncation, git filtering, session counting, and response shape.
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
} from "./projects-discovered";

describe("handleGetDiscoveredProjects", () => {
  beforeEach(() => {
    clearDiscoveredProjectsCache();
    resetMocks();
  });

  // ── Test 1: agent not found ──────────────────────────────────────────────

  it("returns 404 when agent is not in the DB", async () => {
    const db = makeDb([]);

    const res = await handleGetDiscoveredProjects(db);

    expect(res.status).toBe(404);

    const body = await res.json() as { error: string };
    expect(body).toEqual({ error: "Agent not registered" });
  });

  // ── Test 2: empty dir (Spec 1, task 3.2 — empty dir) ────────────────────

  it("returns { projects: [], truncated: false } for empty directory", async () => {
    const db = makeDb([makeAgentRow({ projectsDir: "/home/user/empty-projects" })]);

    mockReaddirSync.mockImplementation(() => []);

    const res = await handleGetDiscoveredProjects(db);
    expect(res.status).toBe(200);

    const body = await res.json() as { projects: unknown[]; truncated: boolean };
    expect(body.projects).toEqual([]);
    expect(body.truncated).toBe(false);
  });

  // ── Test 3: readdirSync error (Spec 1, task 3.2 — error path) ────────────

  it("returns { error: ... } when readdirSync throws", async () => {
    const db = makeDb([makeAgentRow({ projectsDir: "/home/user/nonexistent" })]);

    mockReaddirSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });

    const res = await handleGetDiscoveredProjects(db);
    expect(res.status).toBe(200);

    const body = await res.json() as { error: string };
    expect(body.error).toContain("ENOENT");
  });

  // ── Test 4: 101 entries → truncated: true (Spec 1, task 3.2) ─────────────

  it("sets truncated: true when more than 100 git repos exist", async () => {
    const db = makeDb([makeAgentRow({ projectsDir: "/home/user/many-projects" })]);

    const dirs = Array.from({ length: 101 }, (_, i) =>
      dirent(`repo-${String(i).padStart(3, "0")}`, true),
    );
    mockReaddirSync.mockImplementation(
      () => dirs as unknown as ReturnType<typeof import("node:fs").readdirSync>,
    );

    mockExistsSync.mockImplementation((p: string) => p.endsWith("/.git"));

    const res = await handleGetDiscoveredProjects(db);
    expect(res.status).toBe(200);

    const body = await res.json() as { projects: unknown[]; truncated: boolean };
    expect(body.projects.length).toBe(100);
    expect(body.truncated).toBe(true);
  });

  // ── Test 5: filters non-git dirs ─────────────────────────────────────────

  it("returns only git repos (3 of 4 dirs) and activeSessions/totalSessions 0 for all", async () => {
    const db = makeDb([makeAgentRow({ projectsDir: "/home/user/test-projects" })]);

    mockReaddirSync.mockImplementation(() =>
      [
        dirent("alpha", true),
        dirent("beta", true),
        dirent("gamma", true),
        dirent("not-a-git-dir", true),
      ] as unknown as ReturnType<typeof import("node:fs").readdirSync>,
    );

    mockExistsSync.mockImplementation((p: string) => {
      if (p === "/home/user/test-projects/alpha/.git") return true;
      if (p === "/home/user/test-projects/beta/.git") return true;
      if (p === "/home/user/test-projects/gamma/.git") return true;
      return false;
    });

    mockQueryRecentSessions.mockImplementation(() => Promise.resolve([]));

    const res = await handleGetDiscoveredProjects(db);

    expect(res.status).toBe(200);

    const body = await res.json() as {
      projects: Array<{ name: string; activeSessions: number; totalSessions: number }>;
      truncated: boolean;
    };

    expect(body.projects.length).toBe(3);
    expect(body.truncated).toBe(false);
    expect(body.projects.every((p) => p.activeSessions === 0)).toBe(true);
    expect(body.projects.every((p) => p.totalSessions === 0)).toBe(true);
  });

  // ── Test 6: cross-references sessions correctly ──────────────────────────

  it("counts activeSessions and totalSessions per project", async () => {
    const db = makeDb([makeAgentRow({ projectsDir: "/home/user/projects" })]);

    mockReaddirSync.mockImplementation(() =>
      [
        dirent("alpha", true),
        dirent("beta", true),
      ] as unknown as ReturnType<typeof import("node:fs").readdirSync>,
    );

    mockExistsSync.mockImplementation((p: string) =>
      p === "/home/user/projects/alpha/.git" || p === "/home/user/projects/beta/.git",
    );

    mockQueryRecentSessions.mockImplementation(() =>
      Promise.resolve([
        {
          id: "sess-1",
          project: "alpha",
          machine: "test-host",
          status: "active",
          startedAt: new Date(),
          lastActivity: new Date(),
          endedAt: null,
          pid: 12345,
          cwd: "/home/user/projects/alpha/src",
        },
        {
          id: "sess-2",
          project: "alpha",
          machine: "test-host",
          status: "ended",
          startedAt: new Date(Date.now() - 7_200_000),
          lastActivity: new Date(Date.now() - 7_200_000),
          endedAt: new Date(Date.now() - 7_100_000),
          pid: null,
          cwd: "/home/user/projects/alpha",
        },
      ]),
    );

    const res = await handleGetDiscoveredProjects(db);

    expect(res.status).toBe(200);

    const body = await res.json() as {
      projects: Array<{ name: string; path: string; activeSessions: number; totalSessions: number }>;
    };

    const alpha = body.projects.find((p) => p.name === "alpha");
    const beta = body.projects.find((p) => p.name === "beta");

    expect(alpha).toBeDefined();
    expect(alpha!.activeSessions).toBe(1);
    expect(alpha!.totalSessions).toBe(2);

    expect(beta).toBeDefined();
    expect(beta!.activeSessions).toBe(0);
    expect(beta!.totalSessions).toBe(0);
  });

  // ── Test 7: response shape uses { projects, truncated } not old { total, projectsDir } ──

  it("response has truncated field and no projectsDir or total fields", async () => {
    const db = makeDb([makeAgentRow({ projectsDir: "/home/user/shape-test" })]);

    mockReaddirSync.mockImplementation(() => []);

    const res = await handleGetDiscoveredProjects(db);
    const body = await res.json() as Record<string, unknown>;

    expect("truncated" in body).toBe(true);
    expect("projectsDir" in body).toBe(false);
    expect("total" in body).toBe(false);
  });
});
