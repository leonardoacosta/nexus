/**
 * GET /roadmap route tests (add-bead-proposal-roadmap-surface 1.11).
 *
 * Exercises the exported handler directly. The config-loader is mocked with
 * a per-file fixture registry (mirrors specs.test.ts) so project resolution
 * is deterministic; the no-.beads path avoids shelling to `bd` and yields
 * the `{ capabilities: [] }` wire shape.
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

import { handleGetRoadmap } from "./roadmap";
import type { RoadmapCapability } from "@nexus/core";
import type { FanOutProject } from "../services/project-fanout";

function cap(name: string): RoadmapCapability {
  return {
    name,
    epicId: `epic-${name}`,
    epicStatus: "open",
    proposals: [],
    progress: { totalTasks: 0, closedTasks: 0 },
  };
}

describe("handleGetRoadmap", () => {
  it("returns 400 when the project param is missing", async () => {
    const response = await handleGetRoadmap(new URL("http://localhost/roadmap"));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("missing project");
  });

  it("returns 404 for an unknown project", async () => {
    const response = await handleGetRoadmap(
      new URL("http://localhost/roadmap?project=zzz-nope"),
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("unknown project");
  });

  it("returns { capabilities: [] } for a project with no .beads/ dir", async () => {
    const root = mkdtempSync(join(tmpdir(), "nx-roadmap-route-"));
    fixtureProjects.push({ code: "fix", name: "fixture", path: root });
    try {
      const response = await handleGetRoadmap(
        new URL("http://localhost/roadmap?project=fix"),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/json");
      const body = (await response.json()) as { capabilities: unknown[] };
      expect(Array.isArray(body.capabilities)).toBe(true);
      expect(body.capabilities).toEqual([]);
    } finally {
      fixtureProjects.length = 0;
      rmSync(root, { recursive: true, force: true });
    }
  });

  describe("project=all", () => {
    const projects: FanOutProject[] = [
      { code: "a", path: "/dev/a" },
      { code: "b", path: "/dev/b" },
      { code: "c", path: "/dev/c" },
    ];

    it("merges resolvable projects' capabilities tagged with project, drops empties", async () => {
      const response = await handleGetRoadmap(
        new URL("http://localhost/roadmap?project=all"),
        undefined,
        {
          resolveProjects: async () => projects,
          // `c` has no .beads/ (empty) — contributes nothing.
          computeRoadmap: async (path) =>
            path === "/dev/c" ? [] : [cap(path)],
        },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { capabilities: RoadmapCapability[] };
      expect(body.capabilities).toHaveLength(2);
      expect(body.capabilities.map((c) => c.project).sort()).toEqual(["a", "b"]);
    });

    it("degrades when one project's computeRoadmap throws (200, others survive)", async () => {
      const response = await handleGetRoadmap(
        new URL("http://localhost/roadmap?project=all"),
        undefined,
        {
          resolveProjects: async () => projects,
          computeRoadmap: async (path) => {
            if (path === "/dev/b") throw new Error("bd exploded");
            return [cap(path)];
          },
        },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { capabilities: RoadmapCapability[] };
      expect(body.capabilities.map((c) => c.project).sort()).toEqual(["a", "c"]);
    });
  });

  it("single-project shape carries no project tag (byte-compatible)", async () => {
    fixtureProjects.push({ code: "nx", name: "nexus", path: "/dev/nx" });
    try {
      const response = await handleGetRoadmap(
        new URL("http://localhost/roadmap?project=nx"),
        undefined,
        { computeRoadmap: async () => [cap("only")] },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { capabilities: RoadmapCapability[] };
      expect(body.capabilities).toHaveLength(1);
      expect("project" in body.capabilities[0]!).toBe(false);
    } finally {
      fixtureProjects.length = 0;
    }
  });
});
