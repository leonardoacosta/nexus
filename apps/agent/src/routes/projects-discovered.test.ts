import { describe, expect, it, beforeEach, mock } from "bun:test";
import type { Db } from "@nexus/db";

// ── Module mocks (must be declared before importing the unit under test) ──────

// Mock node:fs so readdirSync / existsSync are controllable per-test
const mockReaddirSync = mock(() => [] as ReturnType<typeof import("node:fs").readdirSync>);
const mockExistsSync = mock((_p: string) => false);

mock.module("node:fs", () => ({
  // Named exports
  readdirSync: mockReaddirSync,
  existsSync: mockExistsSync,
  // Default export — required so `import fs from "node:fs"` binds to the mock
  default: {
    readdirSync: mockReaddirSync,
    existsSync: mockExistsSync,
  },
}));

// Mock ../db/sessions so queryRecentSessions doesn't hit a real DB
const mockQueryRecentSessions = mock((): Promise<{ id: string; project: string; machine: string; status: string; startedAt: string; lastActivity: string; endedAt: string | null; pid: number | null; cwd: string | null }[]> => Promise.resolve([]));

mock.module("../db/sessions", () => ({
  queryRecentSessions: mockQueryRecentSessions,
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
    mockQueryRecentSessions.mockImplementation(() => Promise.resolve([]));
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
      projectsDir: "/tmp/empty-projects",
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
      projectsDir: "/nonexistent",
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
      projectsDir: "/tmp/many-projects",
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

  it("returns only git repos (3 of 4 dirs) and hasActiveSessions false for all", async () => {
    const agentRow = {
      id: "test-host",
      name: "test-host",
      host: "test-host",
      port: 7400,
      projectsDir: "/tmp/test-projects",
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
      if (p === "/tmp/test-projects/alpha/.git") return true;
      if (p === "/tmp/test-projects/beta/.git") return true;
      if (p === "/tmp/test-projects/gamma/.git") return true;
      return false;
    });

    // No active sessions
    mockQueryRecentSessions.mockImplementation(() => Promise.resolve([]));

    const res = await handleGetDiscoveredProjects(db);

    expect(res.status).toBe(200);

    const body = await res.json() as {
      projects: Array<{ name: string; hasActiveSessions: boolean }>;
      truncated: boolean;
    };

    expect(body.projects.length).toBe(3);
    expect(body.truncated).toBe(false);
    expect(body.projects.every((p) => p.hasActiveSessions === false)).toBe(true);
  });

  // ── Test 6: cross-references sessions correctly ──────────────────────────

  it("marks alpha as having active sessions and beta as not", async () => {
    const agentRow = {
      id: "test-host",
      name: "test-host",
      host: "test-host",
      port: 7400,
      projectsDir: "/tmp/projects",
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
      p === "/tmp/projects/alpha/.git" || p === "/tmp/projects/beta/.git",
    );

    // One session whose cwd starts under alpha's path
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
          cwd: "/tmp/projects/alpha/src",
        },
      ]),
    );

    const res = await handleGetDiscoveredProjects(db);

    expect(res.status).toBe(200);

    const body = await res.json() as {
      projects: Array<{ name: string; path: string; hasActiveSessions: boolean }>;
    };

    const alpha = body.projects.find((p) => p.name === "alpha");
    const beta = body.projects.find((p) => p.name === "beta");

    expect(alpha).toBeDefined();
    expect(alpha!.hasActiveSessions).toBe(true);

    expect(beta).toBeDefined();
    expect(beta!.hasActiveSessions).toBe(false);
  });

  // ── Test 7: response shape uses { projects, truncated } not old { total, projectsDir } ──

  it("response has truncated field and no projectsDir or total fields", async () => {
    const agentRow = {
      id: "test-host",
      name: "test-host",
      host: "test-host",
      port: 7400,
      projectsDir: "/tmp/shape-test",
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
});
