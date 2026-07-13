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

const fixtureProjects: Array<{ code: string; name: string; path: string }> = [];

mock.module("../services/config-loader", () => ({
  getProjects: () => fixtureProjects.slice(),
  getSettings: () => ({}),
  initConfigLoader: () => {},
  stopConfigLoader: () => {},
}));

import { handleGetUnlinkedBeads } from "./beads-unlinked";
import type { UnlinkedBead } from "@nexus/core";
import type { FanOutProject } from "../services/project-fanout";

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
});
