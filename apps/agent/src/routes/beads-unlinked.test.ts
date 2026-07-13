/**
 * GET /beads/unlinked route tests (add-bead-proposal-roadmap-surface 1.11).
 *
 * Exercises the exported handler directly. The config-loader is mocked with
 * a per-file fixture registry (mirrors specs.test.ts) so project resolution
 * is deterministic; the no-.beads path avoids shelling to `bd`.
 */

import { describe, it, expect, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "@nexus/db";

const fixtureProjects: Array<{ code: string; name: string; path: string }> = [];

mock.module("../services/config-loader", () => ({
  getProjects: () => fixtureProjects.slice(),
  getSettings: () => ({}),
  initConfigLoader: () => {},
  stopConfigLoader: () => {},
}));

import { handleGetUnlinkedBeads } from "./beads-unlinked";
import type { UnlinkedBead } from "@nexus/core";
import { resolveAllProjects, type FanOutProject } from "../services/project-fanout";

function bead(id: string): UnlinkedBead {
  return { id, title: id, status: "open", priority: 2, type: "task" };
}

describe("handleGetUnlinkedBeads", () => {
  it("returns 400 when the project param is missing", async () => {
    const response = await handleGetUnlinkedBeads(
      new URL("http://localhost/beads/unlinked"),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("missing project");
  });

  it("returns 404 for an unknown project", async () => {
    const response = await handleGetUnlinkedBeads(
      new URL("http://localhost/beads/unlinked?project=zzz-nope"),
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("unknown project");
  });

  it("returns { unlinked: [] } for a project with no .beads/ dir", async () => {
    const root = mkdtempSync(join(tmpdir(), "nx-unlinked-route-"));
    fixtureProjects.push({ code: "fix", name: "fixture", path: root });
    try {
      const response = await handleGetUnlinkedBeads(
        new URL("http://localhost/beads/unlinked?project=fix"),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/json");
      const body = (await response.json()) as { unlinked: unknown[] };
      expect(Array.isArray(body.unlinked)).toBe(true);
      expect(body.unlinked).toEqual([]);
    } finally {
      fixtureProjects.length = 0;
      rmSync(root, { recursive: true, force: true });
    }
  });

  describe("project=all", () => {
    const projects: FanOutProject[] = [
      { code: "a", path: "/dev/a" },
      { code: "b", path: "/dev/b" },
    ];

    it("merges both projects' unlinked beads tagged with project", async () => {
      const response = await handleGetUnlinkedBeads(
        new URL("http://localhost/beads/unlinked?project=all"),
        undefined,
        {
          resolveProjects: async () => projects,
          computeUnlinked: async (path) => [bead(`${path}-1`)],
        },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { unlinked: UnlinkedBead[] };
      expect(body.unlinked).toHaveLength(2);
      expect(body.unlinked.map((b) => b.project).sort()).toEqual(["a", "b"]);
    });

    it("a failing project contributes nothing while the route returns 200", async () => {
      const response = await handleGetUnlinkedBeads(
        new URL("http://localhost/beads/unlinked?project=all"),
        undefined,
        {
          resolveProjects: async () => projects,
          computeUnlinked: async (path) => {
            if (path === "/dev/b") throw new Error("bd list failed");
            return [bead(path)];
          },
        },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { unlinked: UnlinkedBead[] };
      expect(body.unlinked.map((b) => b.project)).toEqual(["a"]);
    });

    it("description flows through to the merged response — populated and omitted-when-empty", async () => {
      const response = await handleGetUnlinkedBeads(
        new URL("http://localhost/beads/unlinked?project=all"),
        undefined,
        {
          resolveProjects: async () => projects,
          computeUnlinked: async (path) =>
            path === "/dev/a"
              ? [{ ...bead("a-1"), description: "why this exists" }]
              : [bead("b-1")],
        },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { unlinked: UnlinkedBead[] };
      const a1 = body.unlinked.find((b) => b.id === "a-1")!;
      const b1 = body.unlinked.find((b) => b.id === "b-1")!;
      expect(a1.description).toBe("why this exists");
      expect(b1).not.toHaveProperty("description");
    });

    it("excludes a hidden project from the merged response (real resolveAllProjects, DI seam)", async () => {
      const threeProjects: FanOutProject[] = [
        { code: "a", path: "/dev/a" },
        { code: "b", path: "/dev/b" },
        { code: "c", path: "/dev/c" },
      ];
      const response = await handleGetUnlinkedBeads(
        new URL("http://localhost/beads/unlinked?project=all"),
        {} as Db,
        {
          resolveProjects: (db) =>
            resolveAllProjects(db, {
              listProjects: () =>
                threeProjects.map((p) => ({ code: p.code, path: p.path })),
              listHidden: async () => [
                { path: "/dev/b", hidden: true },
                { path: "/dev/c", hidden: false },
              ],
            }),
          computeUnlinked: async (path) => [bead(path)],
        },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { unlinked: UnlinkedBead[] };
      expect(body.unlinked.map((b) => b.project).sort()).toEqual(["a", "c"]);
    });
  });

  it("single-project shape carries no project tag (byte-compatible)", async () => {
    fixtureProjects.push({ code: "nx", name: "nexus", path: "/dev/nx" });
    try {
      const response = await handleGetUnlinkedBeads(
        new URL("http://localhost/beads/unlinked?project=nx"),
        undefined,
        { computeUnlinked: async () => [bead("solo")] },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { unlinked: UnlinkedBead[] };
      expect(body.unlinked).toHaveLength(1);
      expect("project" in body.unlinked[0]!).toBe(false);
    } finally {
      fixtureProjects.length = 0;
    }
  });

  it("single-project response: description populated when present, omitted when absent", async () => {
    fixtureProjects.push({ code: "nx", name: "nexus", path: "/dev/nx" });
    try {
      const response = await handleGetUnlinkedBeads(
        new URL("http://localhost/beads/unlinked?project=nx"),
        undefined,
        {
          computeUnlinked: async () => [
            { ...bead("solo-desc"), description: "solo description" },
            bead("solo-empty"),
          ],
        },
      );
      const body = (await response.json()) as { unlinked: UnlinkedBead[] };
      const withDesc = body.unlinked.find((b) => b.id === "solo-desc")!;
      const withoutDesc = body.unlinked.find((b) => b.id === "solo-empty")!;
      expect(withDesc.description).toBe("solo description");
      expect(withoutDesc).not.toHaveProperty("description");
    } finally {
      fixtureProjects.length = 0;
    }
  });
});
