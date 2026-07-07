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
});
