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
});
