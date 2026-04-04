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
const mockQueryRecentSessions = mock(() => Promise.resolve([]));

mock.module("../db/sessions", () => ({
  queryRecentSessions: mockQueryRecentSessions,
}));

// Import the unit under test AFTER mocks are registered
import {
  handleGetDiscoveredProjects,
  clearDiscoveredProjectsCache,
} from "./projects-discovered";

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

// ── Tests ─────────────────────────────────────────────────────────────────────

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

  // ── Test 2: filters non-git dirs ─────────────────────────────────────────

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
      projectsDir: string;
      total: number;
    };

    expect(body.projects.length).toBe(3);
    expect(body.total).toBe(3);
    expect(body.projects.every((p) => p.hasActiveSessions === false)).toBe(true);
  });

  // ── Test 3: cross-references sessions correctly ──────────────────────────

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
});
