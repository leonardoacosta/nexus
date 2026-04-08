/**
 * handleGetDiscoveredProjects edge case tests — path traversal, symlinks,
 * unconfigured projectsDir, outside /home/, and sequential dedup.
 */

import {
  makeDb,
  makeAgentRow,
  resetMocks,
  mockReaddirSync,
  mockExistsSync,
  mockRealpathSync,
} from "./projects-discovered.helpers";

import { describe, expect, it, beforeEach } from "bun:test";
import {
  handleGetDiscoveredProjects,
  clearDiscoveredProjectsCache,
} from "./projects-discovered";

describe("handleGetDiscoveredProjects — edge cases", () => {
  beforeEach(() => {
    clearDiscoveredProjectsCache();
    resetMocks();
  });

  // ── Test 6b: path traversal rejected ─────────────────────────────────────

  it("rejects projectsDir containing path traversal sequences", async () => {
    const db = makeDb([makeAgentRow({ projectsDir: "/tmp/../etc" })]);

    const res = await handleGetDiscoveredProjects(db);
    expect(res.status).toBe(400);

    const body = await res.json() as { error: string };
    expect(body.error).toContain("path traversal");
  });

  // ── Test 6c: unconfigured projectsDir returns configured: false ───────────

  it("returns configured: false when projectsDir is empty", async () => {
    const db = makeDb([makeAgentRow({ projectsDir: "" })]);

    const res = await handleGetDiscoveredProjects(db);
    expect(res.status).toBe(200);

    const body = await res.json() as { projects: unknown[]; configured: boolean };
    expect(body.configured).toBe(false);
    expect(body.projects).toEqual([]);
  });

  // ── Test 6d: symlink dedup — symlink pointing to another project in same dir ──

  it("deduplicates a symlink that resolves to an existing project in the same projectsDir", async () => {
    const db = makeDb([makeAgentRow({ projectsDir: "/home/user/dev" })]);

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

    const res = await handleGetDiscoveredProjects(db);
    expect(res.status).toBe(200);

    const body = await res.json() as {
      projects: Array<{ name: string; path: string }>;
      truncated: boolean;
    };

    expect(body.projects.length).toBe(1);
    expect(body.projects[0]!.name).toBe("nx");
    expect(body.projects[0]!.path).toBe("/home/user/dev/nx");
    expect(body.truncated).toBe(false);
  });

  // ── Test 7.2: absolute path outside /home/ or /Users/ rejected ──────────

  it("rejects projectsDir that resolves outside /home/ or /Users/", async () => {
    const db = makeDb([makeAgentRow({ projectsDir: "/var/data/projects" })]);

    const res = await handleGetDiscoveredProjects(db);
    expect(res.status).toBe(400);

    const body = await res.json() as { error: string };
    expect(body.error).toContain("/home/");
    expect(body.error).toContain("/Users/");
  });

  // ── Test 2.2: symlink dedup persists across two calls (module-scope dedup set) ──

  it("deduplicates symlinks across two sequential calls (module-scope seenCanonicalPaths)", async () => {
    const db = makeDb([makeAgentRow({ projectsDir: "/home/user/dev" })]);

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
    expect(body2.projects.length).toBe(1);
    expect(body2.projects[0]!.name).toBe("nx");
  });
});
