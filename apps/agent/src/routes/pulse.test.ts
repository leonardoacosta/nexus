/**
 * GET /projects/:code/pulse route tests (nx-0bhyl.1).
 *
 * Exercises both the pure helpers (isStandaloneBead / computeOpenspecPulse /
 * computeBeadsPulse / computeNextLine) directly and the exported handler via
 * DI seams (mirrors roadmap.test.ts's fixture-registry + injected-deps
 * pattern, so config-loader / spec-watcher / cached-bead-source never
 * actually spawn `bd`/`openspec`).
 */

import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawBead } from "../services/bead-rollup";
import type { SpecSnapshot } from "../services/spec-watcher";
import {
  isStandaloneBead,
  computeOpenspecPulse,
  computeBeadsPulse,
  computeNextLine,
  handleGetProjectPulse,
  tryHandlePulseRoute,
} from "./pulse";

function bead(overrides: Partial<RawBead> & { id: string }): RawBead {
  return {
    title: "",
    status: "open",
    issue_type: "task",
    priority: 2,
    ...overrides,
  };
}

function spec(name: string, completed: number, total: number): SpecSnapshot {
  return { name, status: "active", completedTasks: completed, totalTasks: total };
}

describe("isStandaloneBead", () => {
  it("is standalone when it has no parent", () => {
    const b = bead({ id: "nx-1" });
    expect(isStandaloneBead(b, new Map())).toBe(true);
  });

  it("is NOT standalone when an ancestor is [CAPABILITY]-titled", () => {
    const epic = bead({ id: "nx-epic", title: "[CAPABILITY] Foo" });
    const child = bead({ id: "nx-1", parent: "nx-epic" });
    const byId = new Map([["nx-epic", epic], ["nx-1", child]]);
    expect(isStandaloneBead(child, byId)).toBe(false);
  });

  it("is NOT standalone when a [SPEC]-titled ancestor is two hops up", () => {
    const spec_ = bead({ id: "nx-spec", title: "[SPEC] Bar" });
    const feature = bead({ id: "nx-feature", parent: "nx-spec" });
    const task = bead({ id: "nx-task", parent: "nx-feature" });
    const byId = new Map([
      ["nx-spec", spec_],
      ["nx-feature", feature],
      ["nx-task", task],
    ]);
    expect(isStandaloneBead(task, byId)).toBe(false);
  });

  it("is standalone when the parent chain has no [SPEC]/[CAPABILITY] ancestor", () => {
    const parent = bead({ id: "nx-parent", title: "Some other epic" });
    const child = bead({ id: "nx-1", parent: "nx-parent" });
    const byId = new Map([["nx-parent", parent], ["nx-1", child]]);
    expect(isStandaloneBead(child, byId)).toBe(true);
  });

  it("does not infinite-loop on a cyclic parent chain", () => {
    const a = bead({ id: "nx-a", parent: "nx-b" });
    const b = bead({ id: "nx-b", parent: "nx-a" });
    const byId = new Map([["nx-a", a], ["nx-b", b]]);
    expect(isStandaloneBead(a, byId)).toBe(true);
  });
});

describe("computeBeadsPulse", () => {
  it("counts only standalone, non-epic, open-ish beads", () => {
    const epic = bead({ id: "nx-epic", title: "[CAPABILITY] Foo", issue_type: "epic" });
    const capChild = bead({ id: "nx-1", parent: "nx-epic" }); // NOT standalone
    const standaloneOpen = bead({ id: "nx-2" });
    const standaloneClosed = bead({ id: "nx-3", status: "closed" });
    const epicItself = bead({ id: "nx-4", issue_type: "epic" }); // excluded (epic)

    const beads = [epic, capChild, standaloneOpen, standaloneClosed, epicItself];
    const result = computeBeadsPulse(beads);
    expect(result.open).toBe(1);
    expect(result.ready).toBe(1);
    expect(result.blocked).toBe(0);
  });

  it("classifies a bead with an unclosed `blocks` dependency as blocked, not ready", () => {
    const blocker = bead({ id: "nx-blocker", status: "open" });
    const blocked = bead({
      id: "nx-blocked",
      dependencies: [{ depends_on_id: "nx-blocker", type: "blocks" }],
    });
    const result = computeBeadsPulse([blocker, blocked]);
    expect(result.open).toBe(2);
    expect(result.ready).toBe(1);
    expect(result.blocked).toBe(1);
  });

  it("returns all zeros for an empty bead set", () => {
    expect(computeBeadsPulse([])).toEqual({ open: 0, ready: 0, blocked: 0 });
  });
});

describe("computeOpenspecPulse", () => {
  it("has_specs: false and all zeros for no specs", () => {
    expect(computeOpenspecPulse([])).toEqual({
      open: 0,
      in_progress: 0,
      ua: 0,
      has_specs: false,
    });
  });

  it("classifies open (no tasks started), in-progress (partial), done (complete)", () => {
    const specs = [
      spec("a", 0, 5), // open
      spec("b", 2, 5), // in-progress
      spec("c", 5, 5), // done (ua)
      spec("d", 0, 0), // no tasks.md yet -> open
    ];
    const result = computeOpenspecPulse(specs);
    expect(result).toEqual({ open: 2, in_progress: 1, ua: 1, has_specs: true });
  });
});

describe("computeNextLine", () => {
  it("prefers a P0/P1 ready bead over closure debt", () => {
    const critical = bead({ id: "nx-1", priority: 0, title: "Fix the thing" });
    const specs = [spec("done-spec", 3, 3)];
    expect(computeNextLine([critical], specs)).toBe("Fix the thing");
  });

  it("falls back to closure debt when no P0/P1 ready bead exists", () => {
    const specs = [spec("open-spec", 0, 3), spec("done-spec", 3, 3)];
    expect(computeNextLine([], specs)).toBe("done-spec (archive)");
  });

  it("truncates a long title to 25 chars + ellipsis", () => {
    const critical = bead({
      id: "nx-1",
      priority: 1,
      title: "This is a very long bead title that exceeds the cap",
    });
    const result = computeNextLine([critical], []);
    expect(result).toBe("This is a very long bead ...");
  });

  it("ignores a blocked P0 bead and a closed P0 bead", () => {
    const blocker = bead({ id: "nx-blocker", status: "open" });
    const blockedCritical = bead({
      id: "nx-1",
      priority: 0,
      dependencies: [{ depends_on_id: "nx-blocker", type: "blocks" }],
    });
    const closedCritical = bead({ id: "nx-2", priority: 0, status: "closed" });
    expect(computeNextLine([blocker, blockedCritical, closedCritical], [])).toBeNull();
  });

  it("returns null when nothing is pending", () => {
    expect(computeNextLine([], [])).toBeNull();
  });
});

describe("handleGetProjectPulse", () => {
  it("returns 404 for an unknown project", async () => {
    const response = await handleGetProjectPulse("zzz-nope", {
      resolveProject: () => null,
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("unknown project");
  });

  it("returns op/bd null when neither openspec/ nor .beads/ exist on disk", async () => {
    const response = await handleGetProjectPulse("fix", {
      resolveProject: () => ({ code: "fix", name: "fixture", path: "/nonexistent-nx-fixture" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { op: unknown; bd: unknown; next: unknown };
    expect(body.op).toBeNull();
    expect(body.bd).toBeNull();
    expect(body.next).toBeNull();
  });

  it("assembles op/bd/next from injected spec + bead sources", async () => {
    const root = mkdtempSync(join(tmpdir(), "nx-pulse-route-"));
    mkdirSync(join(root, "openspec"));
    mkdirSync(join(root, ".beads"));
    try {
      const response = await handleGetProjectPulse("fix", {
        resolveProject: () => ({ code: "fix", name: "fixture", path: root }),
        pollSpecs: async () => [spec("open-spec", 0, 3), spec("done-spec", 3, 3)],
        listBeads: async () => [bead({ id: "nx-1", priority: 0, title: "Ship it" })],
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        op: { open: number; in_progress: number; ua: number; has_specs: boolean };
        bd: { open: number; ready: number; blocked: number };
        next: string | null;
      };
      expect(body.op).toEqual({ open: 1, in_progress: 0, ua: 1, has_specs: true });
      expect(body.bd).toEqual({ open: 1, ready: 1, blocked: 0 });
      expect(body.next).toBe("Ship it");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("degrades op to null (never 500s) when pollSpecs throws", async () => {
    const root = mkdtempSync(join(tmpdir(), "nx-pulse-route-"));
    mkdirSync(join(root, "openspec"));
    try {
      const response = await handleGetProjectPulse("fix", {
        resolveProject: () => ({ code: "fix", name: "fixture", path: root }),
        pollSpecs: async () => {
          throw new Error("boom");
        },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { op: unknown };
      expect(body.op).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("tryHandlePulseRoute", () => {
  it("returns null for a non-matching path (falls through)", () => {
    const request = new Request("http://localhost/projects/fix/status");
    const url = new URL(request.url);
    expect(tryHandlePulseRoute(request, url)).toBeNull();
  });

  it("returns null for the wrong method", () => {
    const request = new Request("http://localhost/projects/fix/pulse", { method: "POST" });
    const url = new URL(request.url);
    expect(tryHandlePulseRoute(request, url)).toBeNull();
  });

  it("matches GET /projects/:code/pulse and returns a Response", async () => {
    const request = new Request("http://localhost/projects/zzz-nope/pulse");
    const url = new URL(request.url);
    const result = tryHandlePulseRoute(request, url);
    expect(result).not.toBeNull();
    const response = await result!;
    expect(response.status).toBe(404);
  });
});
