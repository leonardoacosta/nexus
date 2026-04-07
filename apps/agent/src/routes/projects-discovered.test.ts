import { describe, expect, it, beforeEach, mock } from "bun:test";
import type { Db } from "@nexus/db";

// ── Module mocks (must be declared before importing the unit under test) ──────

// Mock node:fs so readdirSync / existsSync / realpathSync are controllable per-test
const mockReaddirSync = mock(() => [] as ReturnType<typeof import("node:fs").readdirSync>);
const mockExistsSync = mock((_p: string) => false);
// Default: return the path unchanged (no symlink resolution needed for most tests)
const mockRealpathSync = mock((p: string) => p);

mock.module("node:fs", () => ({
  // Named exports
  readdirSync: mockReaddirSync,
  existsSync: mockExistsSync,
  realpathSync: mockRealpathSync,
  // Default export — required so `import fs from "node:fs"` binds to the mock
  default: {
    readdirSync: mockReaddirSync,
    existsSync: mockExistsSync,
    realpathSync: mockRealpathSync,
  },
}));

// Mock ../db/sessions so queryRecentSessions doesn't hit a real DB
const mockQueryRecentSessions = mock((): Promise<{ id: string; project: string; machine: string; status: string; startedAt: string; lastActivity: string; endedAt: string | null; pid: number | null; cwd: string | null }[]> => Promise.resolve([]));

mock.module("../db/sessions", () => ({
  queryRecentSessions: mockQueryRecentSessions,
}));

// Mock ../db/project-registry so upsertProjectLocations doesn't hit a real DB
const mockUpsertProjectLocations = mock((): Promise<void> => Promise.resolve());

mock.module("../db/project-registry", () => ({
  upsertProjectLocations: mockUpsertProjectLocations,
}));

// Import the unit under test AFTER mocks are registered
import {
  handleGetDiscoveredProjects,
  clearDiscoveredProjectsCache,
  expandProjectsDir,
} from "./projects-discovered";
import os from "node:os";
import path from "node:path";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal mock Db whose select chain returns the supplied rows. */
function makeDb(rows: unknown[]): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(rows),
        }),
      }),
    }),
  } as unknown as Db;
}

/** Build a Dirent-like object for use as a readdirSync entry. */
function dirent(name: string, isDir: boolean) {
  return { name, isDirectory: () => isDir };
}

// ── Tilde expansion tests (Spec 1, task 3.1) ──────────────────────────────────

describe("expandProjectsDir", () => {
  it("expands leading ~ to home directory", () => {
    const result = expandProjectsDir("~/dev");
    expect(result).toBe(path.join(os.homedir(), "dev"));
    expect(path.isAbsolute(result)).toBe(true);
  });

  it("returns absolute path unchanged", () => {
    const result = expandProjectsDir("/tmp/projects");
    expect(result).toBe("/tmp/projects");
  });

  it("resolves relative path to absolute via path.resolve", () => {
    const result = expandProjectsDir("relative/path");
    expect(path.isAbsolute(result)).toBe(true);
  });

  it("expands ~/ prefix to home directory", () => {
    const result = expandProjectsDir("~/foo/bar");
    expect(result).toBe(path.join(os.homedir(), "foo", "bar"));
  });
});

// ── handleGetDiscoveredProjects tests ─────────────────────────────────────────

describe("handleGetDiscoveredProjects", () => {
  beforeEach(() => {
    // Reset TTL cache so each test starts cold
    clearDiscoveredProjectsCache();

    // Reset all mocks to their default (safe) implementations
    mockReaddirSync.mockImplementation(() => []);
    mockExistsSync.mockImplementation(() => false);
    mockRealpathSync.mockImplementation((p: string) => p);
    mockQueryRecentSessions.mockImplementation(() => Promise.resolve([]));
    mockUpsertProjectLocations.mockImplementation(() => Promise.resolve());
  });

  // ── Test 1: agent not found ──────────────────────────────────────────────

  it("returns 404 when agent is not in the DB", async () => {
    const db = makeDb([]); // empty rows → agent not found

    const res = await handleGetDiscoveredProjects(db);

    expect(res.status).toBe(404);

    const body = await res.json() as { error: string };
    expect(body).toEqual({ error: "Agent not registered" });
  });

  // ── Test 2: empty dir (Spec 1, task 3.2 — empty dir) ────────────────────

  it("returns { projects: [], truncated: false } for empty directory", async () => {
    const agentRow = {
      id: "test-host",
      name: "test-host",
      host: "test-host",
      port: 7400,
      projectsDir: "/home/user/empty-projects",
      enabled: true,
      lastSeen: null,
      createdAt: null,
    };
    const db = makeDb([agentRow]);

    mockReaddirSync.mockImplementation(() => []);

    const res = await handleGetDiscoveredProjects(db);
    expect(res.status).toBe(200);

    const body = await res.json() as { projects: unknown[]; truncated: boolean };
    expect(body.projects).toEqual([]);
    expect(body.truncated).toBe(false);
  });

  // ── Test 3: readdirSync error (Spec 1, task 3.2 — error path) ────────────

  it("returns { error: ... } when readdirSync throws", async () => {
    const agentRow = {
      id: "test-host",
      name: "test-host",
      host: "test-host",
      port: 7400,
      projectsDir: "/home/user/nonexistent",
      enabled: true,
      lastSeen: null,
      createdAt: null,
    };
    const db = makeDb([agentRow]);

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
    const agentRow = {
      id: "test-host",
      name: "test-host",
      host: "test-host",
      port: 7400,
      projectsDir: "/home/user/many-projects",
      enabled: true,
      lastSeen: null,
      createdAt: null,
    };
    const db = makeDb([agentRow]);

    // 101 directories
    const dirs = Array.from({ length: 101 }, (_, i) =>
      dirent(`repo-${String(i).padStart(3, "0")}`, true),
    );
    mockReaddirSync.mockImplementation(
      () => dirs as unknown as ReturnType<typeof import("node:fs").readdirSync>,
    );

    // All dirs have .git
    mockExistsSync.mockImplementation((p: string) => p.endsWith("/.git"));

    const res = await handleGetDiscoveredProjects(db);
    expect(res.status).toBe(200);

    const body = await res.json() as { projects: unknown[]; truncated: boolean };
    expect(body.projects.length).toBe(100);
    expect(body.truncated).toBe(true);
  });

  // ── Test 5: filters non-git dirs ─────────────────────────────────────────

  it("returns only git repos (3 of 4 dirs) and activeSessions/totalSessions 0 for all", async () => {
    const agentRow = {
      id: "test-host",
      name: "test-host",
      host: "test-host",
      port: 7400,
      projectsDir: "/home/user/test-projects",
      enabled: true,
      lastSeen: null,
      createdAt: null,
    };

    const db = makeDb([agentRow]);

    // 4 entries: 3 directories with .git, 1 directory without .git
    mockReaddirSync.mockImplementation(() =>
      [
        dirent("alpha", true),
        dirent("beta", true),
        dirent("gamma", true),
        dirent("not-a-git-dir", true),
      ] as unknown as ReturnType<typeof import("node:fs").readdirSync>,
    );

    // existsSync returns true only for paths ending in "/.git"
    // alpha, beta, gamma have .git; not-a-git-dir does not
    mockExistsSync.mockImplementation((p: string) => {
      if (p === "/home/user/test-projects/alpha/.git") return true;
      if (p === "/home/user/test-projects/beta/.git") return true;
      if (p === "/home/user/test-projects/gamma/.git") return true;
      return false;
    });

    // No active sessions
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
    const agentRow = {
      id: "test-host",
      name: "test-host",
      host: "test-host",
      port: 7400,
      projectsDir: "/home/user/projects",
      enabled: true,
      lastSeen: null,
      createdAt: null,
    };

    const db = makeDb([agentRow]);

    mockReaddirSync.mockImplementation(() =>
      [
        dirent("alpha", true),
        dirent("beta", true),
      ] as unknown as ReturnType<typeof import("node:fs").readdirSync>,
    );

    mockExistsSync.mockImplementation((p: string) =>
      p === "/home/user/projects/alpha/.git" || p === "/home/user/projects/beta/.git",
    );

    // One active session and one ended session under alpha; none under beta
    mockQueryRecentSessions.mockImplementation(() =>
      Promise.resolve([
        {
          id: "sess-1",
          project: "alpha",
          machine: "test-host",
          status: "active",
          startedAt: new Date().toISOString(),
          lastActivity: new Date().toISOString(),
          endedAt: null,
          pid: 12345,
          cwd: "/home/user/projects/alpha/src",
        },
        {
          id: "sess-2",
          project: "alpha",
          machine: "test-host",
          status: "ended",
          startedAt: new Date(Date.now() - 7_200_000).toISOString(),
          lastActivity: new Date(Date.now() - 7_200_000).toISOString(),
          endedAt: new Date(Date.now() - 7_100_000).toISOString(),
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

  // ── Test 6b: path traversal rejected ─────────────────────────────────────

  it("rejects projectsDir containing path traversal sequences", async () => {
    const agentRow = {
      id: "test-host",
      name: "test-host",
      host: "test-host",
      port: 7400,
      projectsDir: "/tmp/../etc",
      enabled: true,
      lastSeen: null,
      createdAt: null,
    };
    const db = makeDb([agentRow]);

    const res = await handleGetDiscoveredProjects(db);
    expect(res.status).toBe(400);

    const body = await res.json() as { error: string };
    expect(body.error).toContain("path traversal");
  });

  // ── Test 6c: unconfigured projectsDir returns configured: false ───────────

  it("returns configured: false when projectsDir is empty", async () => {
    const agentRow = {
      id: "test-host",
      name: "test-host",
      host: "test-host",
      port: 7400,
      projectsDir: "",
      enabled: true,
      lastSeen: null,
      createdAt: null,
    };
    const db = makeDb([agentRow]);

    const res = await handleGetDiscoveredProjects(db);
    expect(res.status).toBe(200);

    const body = await res.json() as { projects: unknown[]; configured: boolean };
    expect(body.configured).toBe(false);
    expect(body.projects).toEqual([]);
  });

  // ── Test 6d: symlink dedup — symlink pointing to another project in same dir ──

  it("deduplicates a symlink that resolves to an existing project in the same projectsDir", async () => {
    const agentRow = {
      id: "test-host",
      name: "test-host",
      host: "test-host",
      port: 7400,
      projectsDir: "/home/user/dev",
      enabled: true,
      lastSeen: null,
      createdAt: null,
    };
    const db = makeDb([agentRow]);

    // "nx" is a real directory; "link-to-nx" is a symlink
    mockReaddirSync.mockImplementation(() =>
      [
        { name: "nx", isDirectory: () => true, isSymbolicLink: () => false },
        { name: "link-to-nx", isDirectory: () => false, isSymbolicLink: () => true },
      ] as unknown as ReturnType<typeof import("node:fs").readdirSync>,
    );

    // realpathSync: both paths resolve to the same canonical path
    mockRealpathSync.mockImplementation((p: string) => {
      if (p === "/home/user/dev/nx") return "/home/user/dev/nx";
      if (p === "/home/user/dev/link-to-nx") return "/home/user/dev/nx";
      return p;
    });

    // Only the canonical path has a .git directory
    mockExistsSync.mockImplementation((p: string) => p === "/home/user/dev/nx/.git");

    const res = await handleGetDiscoveredProjects(db);
    expect(res.status).toBe(200);

    const body = await res.json() as {
      projects: Array<{ name: string; path: string }>;
      truncated: boolean;
    };

    // Exactly one project — the real directory "nx"; "link-to-nx" was deduplicated
    expect(body.projects.length).toBe(1);
    expect(body.projects[0]!.name).toBe("nx");
    expect(body.projects[0]!.path).toBe("/home/user/dev/nx");
    expect(body.truncated).toBe(false);
  });

  // ── Test 7: response shape uses { projects, truncated } not old { total, projectsDir } ──

  it("response has truncated field and no projectsDir or total fields", async () => {
    const agentRow = {
      id: "test-host",
      name: "test-host",
      host: "test-host",
      port: 7400,
      projectsDir: "/home/user/shape-test",
      enabled: true,
      lastSeen: null,
      createdAt: null,
    };
    const db = makeDb([agentRow]);

    mockReaddirSync.mockImplementation(() => []);

    const res = await handleGetDiscoveredProjects(db);
    const body = await res.json() as Record<string, unknown>;

    expect("truncated" in body).toBe(true);
    expect("projectsDir" in body).toBe(false);
    expect("total" in body).toBe(false);
  });

  // ── Test 7.2: absolute path outside /home/ or /Users/ rejected ──────────

  it("rejects projectsDir that resolves outside /home/ or /Users/", async () => {
    const agentRow = {
      id: "test-host",
      name: "test-host",
      host: "test-host",
      port: 7400,
      projectsDir: "/var/data/projects",
      enabled: true,
      lastSeen: null,
      createdAt: null,
    };
    const db = makeDb([agentRow]);

    const res = await handleGetDiscoveredProjects(db);
    expect(res.status).toBe(400);

    const body = await res.json() as { error: string };
    expect(body.error).toContain("/home/");
    expect(body.error).toContain("/Users/");
  });

  // ── Test 2.2: symlink dedup persists across two calls (module-scope dedup set) ──

  it("deduplicates symlinks across two sequential calls (module-scope seenCanonicalPaths)", async () => {
    const agentRow = {
      id: "test-host",
      name: "test-host",
      host: "test-host",
      port: 7400,
      projectsDir: "/home/user/dev",
      enabled: true,
      lastSeen: null,
      createdAt: null,
    };
    const db = makeDb([agentRow]);

    // "nx" is a real directory; "link-to-nx" is a symlink — both resolve to same canonical path
    mockReaddirSync.mockImplementation(() =>
      [
        { name: "nx", isDirectory: () => true, isSymbolicLink: () => false },
        { name: "link-to-nx", isDirectory: () => false, isSymbolicLink: () => true },
      ] as unknown as ReturnType<typeof import("node:fs").readdirSync>,
    );

    mockRealpathSync.mockImplementation((p: string) => {
      if (p === "/home/user/dev/nx") return "/home/user/dev/nx";
      if (p === "/home/user/dev/link-to-nx") return "/home/user/dev/nx";
      return p;
    });

    mockExistsSync.mockImplementation((p: string) => p === "/home/user/dev/nx/.git");

    // First call
    clearDiscoveredProjectsCache();
    const res1 = await handleGetDiscoveredProjects(db);
    expect(res1.status).toBe(200);
    const body1 = await res1.json() as { projects: Array<{ name: string }> };
    expect(body1.projects.length).toBe(1);
    expect(body1.projects[0]!.name).toBe("nx");

    // Second call — cache expired, re-scan
    clearDiscoveredProjectsCache();
    const res2 = await handleGetDiscoveredProjects(db);
    expect(res2.status).toBe(200);
    const body2 = await res2.json() as { projects: Array<{ name: string }> };
    // Must still only be 1 — symlink dedup set is reset per scan cycle
    expect(body2.projects.length).toBe(1);
    expect(body2.projects[0]!.name).toBe("nx");
  });
});
