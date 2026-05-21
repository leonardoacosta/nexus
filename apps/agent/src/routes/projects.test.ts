/**
 * Contract test for GET /projects emission shape.
 *
 * Added by `agent-payload-completeness` (task 1.9). Pins the `hidden`
 * boolean on every row — both registry-backed and synthetic — so the
 * Swift `ProjectAggregate` decoder's required-field contract has a
 * matching agent-side guarantee.
 *
 * Pure-function test against `aggregateProjects` — no PG required.
 */

import { describe, it, expect } from "bun:test";
import { aggregateProjects } from "./projects";
import type { SessionRow } from "../db/sessions";
import type { GitMetadata } from "@nexus/core";

const REG_ID_VISIBLE = "11111111-1111-1111-1111-111111111111";
const REG_ID_HIDDEN = "22222222-2222-2222-2222-222222222222";

function session(over: Partial<SessionRow>): SessionRow {
  return {
    projectId: null,
    status: "active",
    machine: "host-a",
    ...over,
  } as unknown as SessionRow;
}

describe("aggregateProjects — hidden emission (agent-payload-completeness)", () => {
  it("emits hidden=true for a registry row marked hidden", () => {
    const rows = aggregateProjects(
      [session({ projectId: REG_ID_HIDDEN, machine: "host-a" })],
      [{ projectId: REG_ID_HIDDEN, name: "hidden-one", hidden: true }],
    );
    const row = rows.find((r) => r.name === "hidden-one");
    expect(row).toBeDefined();
    expect(row!.hidden).toBe(true);
  });

  it("emits hidden=false for a registry row marked visible", () => {
    const rows = aggregateProjects(
      [],
      [{ projectId: REG_ID_VISIBLE, name: "alpha", hidden: false }],
    );
    const row = rows.find((r) => r.name === "alpha");
    expect(row).toBeDefined();
    expect(row!.hidden).toBe(false);
  });

  it("emits hidden=false on the synthetic (unregistered) bucket", () => {
    const rows = aggregateProjects(
      [session({ projectId: null, machine: "host-b" })],
      [],
    );
    const unreg = rows.find((r) => r.name === "(unregistered)");
    expect(unreg).toBeDefined();
    expect(unreg!.hidden).toBe(false);
  });

  it("defaults hidden=false when a registry row omits the field (legacy callers)", () => {
    const rows = aggregateProjects(
      [],
      // `hidden` deliberately omitted to model an older callsite.
      [{ projectId: REG_ID_VISIBLE, name: "legacy" }],
    );
    const row = rows.find((r) => r.name === "legacy");
    expect(row!.hidden).toBe(false);
  });

  it("every emitted row has `hidden` set (no undefined leakage)", () => {
    const rows = aggregateProjects(
      [
        session({ projectId: REG_ID_VISIBLE, machine: "host-a" }),
        session({ projectId: null, machine: "host-b" }),
      ],
      [
        { projectId: REG_ID_VISIBLE, name: "alpha", hidden: false },
        { projectId: REG_ID_HIDDEN, name: "zeta", hidden: true },
      ],
    );
    for (const row of rows) {
      expect(typeof row.hidden).toBe("boolean");
    }
  });
});

// projects-tab-accordion-deeplink — `git_metadata` threading on the row.
// Pure-function test against `aggregateProjects` with a stubbed metadata
// map (avoids real git subprocess in unit scope).

describe("aggregateProjects — git_metadata emission", () => {
  const REG_ID_GIT = "33333333-3333-3333-3333-333333333333";
  const REG_ID_NOGIT = "44444444-4444-4444-4444-444444444444";

  const sampleMetadata: GitMetadata = {
    branch: "main",
    ahead: 0,
    behind: 0,
    dirty: false,
    last_commit: { author: "Test Author", ts: "2026-05-21T18:00:00-05:00" },
  };

  function session(over: Partial<SessionRow>): SessionRow {
    return {
      projectId: null,
      status: "active",
      machine: "host-a",
      ...over,
    } as unknown as SessionRow;
  }

  it("attaches git_metadata when the map has an entry for the project id", () => {
    const map = new Map<string, GitMetadata | null>([
      [REG_ID_GIT, sampleMetadata],
    ]);
    const rows = aggregateProjects(
      [],
      [{ projectId: REG_ID_GIT, name: "nx", path: "/tmp/nx" }],
      map,
    );
    const row = rows.find((r) => r.name === "nx");
    expect(row).toBeDefined();
    expect(row!.git_metadata).toEqual(sampleMetadata);
  });

  it("emits git_metadata=null when the map has no entry (non-git cwd)", () => {
    const map = new Map<string, GitMetadata | null>();
    const rows = aggregateProjects(
      [],
      [{ projectId: REG_ID_NOGIT, name: "notes", path: "/tmp/notes" }],
      map,
    );
    const row = rows.find((r) => r.name === "notes");
    expect(row!.git_metadata).toBeNull();
  });

  it("session-only fallback buckets always carry git_metadata=null", () => {
    const map = new Map<string, GitMetadata | null>();
    const rows = aggregateProjects(
      [session({ projectId: null, machine: "host-a" })],
      [],
      map,
    );
    const row = rows.find((r) => r.name === "(unregistered)");
    expect(row!.git_metadata).toBeNull();
  });

  it("omitting the metadata map preserves prior call semantics (backward-compat)", () => {
    const rows = aggregateProjects(
      [],
      [{ projectId: REG_ID_GIT, name: "alpha" }],
    );
    const row = rows.find((r) => r.name === "alpha");
    // Wire shape now always includes the field; legacy callers (no map)
    // get null for every row — explicit null, not undefined.
    expect(row!.git_metadata).toBeNull();
  });

  it("budget proxy: 15 projects with cached/stubbed metadata aggregate well under 500ms", () => {
    const REG_PREFIX = "5555aaaa-5555-5555-5555-";
    const registered = Array.from({ length: 15 }, (_, i) => ({
      projectId: REG_PREFIX + i.toString().padStart(12, "0"),
      name: `proj-${i}`,
      path: `/tmp/proj-${i}`,
    }));
    const map = new Map<string, GitMetadata | null>(
      registered.map((r) => [r.projectId, sampleMetadata] as const),
    );
    const start = Date.now();
    const rows = aggregateProjects([], registered, map);
    const elapsed = Date.now() - start;
    // Pure in-memory aggregation; real wall-clock budget (500ms p95) is
    // tested at integration scope in E2E task 3.1.
    expect(elapsed).toBeLessThan(500);
    expect(rows).toHaveLength(15);
    for (const row of rows) {
      expect(row.git_metadata).toEqual(sampleMetadata);
    }
  });
});
