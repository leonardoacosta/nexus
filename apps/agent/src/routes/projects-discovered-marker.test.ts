/**
 * Scanner marker test (folder-based-project-autodiscovery task 2.1).
 *
 * Asserts the discovery scanner matches a directory containing `.git` OR
 * `openspec/` (previously `.git`-only). Spec-only repos (openspec/ but no
 * .git) MUST be discovered because the spec-watcher consumes this registry.
 *
 * Uses the in-process fs/db shims (projects-discovered.helpers) so it self-
 * gates: no PostgreSQL or live agent required.
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

describe("scanner marker — .git OR openspec/ (task 2.1)", () => {
  beforeEach(() => {
    clearDiscoveredProjectsCache();
    resetMocks();
  });

  it("discovers a git repo, an openspec-only repo, and a git+openspec repo; skips a plain dir", async () => {
    const db = makeDb([makeAgentRow({ projectsDir: "/home/user/dev" })]);

    mockReaddirSync.mockImplementation(() =>
      [
        dirent("git-only", true),
        dirent("openspec-only", true),
        dirent("git-and-openspec", true),
        dirent("plain-dir", true),
      ] as unknown as ReturnType<typeof import("node:fs").readdirSync>,
    );

    mockExistsSync.mockImplementation((p: string) => {
      // git-only: has .git, no openspec
      if (p === "/home/user/dev/git-only/.git") return true;
      // openspec-only: NO .git, has openspec/ (the new case)
      if (p === "/home/user/dev/openspec-only/openspec") return true;
      // git-and-openspec: both markers
      if (p === "/home/user/dev/git-and-openspec/.git") return true;
      if (p === "/home/user/dev/git-and-openspec/openspec") return true;
      // plain-dir: neither marker
      return false;
    });

    mockQueryRecentSessions.mockImplementation(() => Promise.resolve([]));

    const res = await handleGetDiscoveredProjects(db);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      projects: Array<{ name: string }>;
      truncated: boolean;
    };

    const names = body.projects.map((p) => p.name).sort();
    expect(names).toEqual(["git-and-openspec", "git-only", "openspec-only"]);
    expect(names).not.toContain("plain-dir");
  });

  it("discovers an openspec-only repo even with no .git at all", async () => {
    const db = makeDb([makeAgentRow({ projectsDir: "/home/user/specs" })]);

    mockReaddirSync.mockImplementation(() =>
      [dirent("docs-repo", true)] as unknown as ReturnType<
        typeof import("node:fs").readdirSync
      >,
    );

    mockExistsSync.mockImplementation(
      (p: string) => p === "/home/user/specs/docs-repo/openspec",
    );
    mockQueryRecentSessions.mockImplementation(() => Promise.resolve([]));

    const res = await handleGetDiscoveredProjects(db);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { projects: Array<{ name: string }> };
    expect(body.projects.length).toBe(1);
    expect(body.projects[0]!.name).toBe("docs-repo");
  });
});
