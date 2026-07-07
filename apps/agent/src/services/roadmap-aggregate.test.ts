/**
 * roadmap-aggregate tests (add-bead-proposal-roadmap-surface task 1.10).
 *
 * `computeRoadmap` is exercised against a tmpdir fixture with an injected
 * fake RoadmapBeadSource (the DI seam) — no bd shelling. Covers the
 * capability -> proposals progress roll-up and the "feature bead points at
 * an archived proposal is classified, not dropped" scenario.
 */

import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeRoadmap,
  classifySpecStatus,
  type RoadmapBeadSource,
} from "./roadmap-aggregate";
import type { RawBead } from "./bead-rollup";

function makeProject(opts: {
  beads?: boolean;
  live?: Record<string, string>;
  archived?: Record<string, string>;
}): string {
  const root = mkdtempSync(join(tmpdir(), "nx-roadmap-"));
  if (opts.beads !== false) mkdirSync(join(root, ".beads"), { recursive: true });
  for (const [name, body] of Object.entries(opts.live ?? {})) {
    const dir = join(root, "openspec", "changes", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "tasks.md"), body);
  }
  for (const [name, body] of Object.entries(opts.archived ?? {})) {
    const dir = join(root, "openspec", "changes", "archive", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "tasks.md"), body);
  }
  return root;
}

/**
 * Build a fake source from: epics, all beads (for parent lookup), a
 * feature-id -> spec_id map, and the linked task/epic/feature beads keyed by
 * id (returned by listBeads). `ready` ids are marked ready.
 */
function fakeSource(opts: {
  epics: RawBead[];
  all: RawBead[];
  specIds: Record<string, string>;
  linkBeads: RawBead[];
  readyIds?: string[];
}): RoadmapBeadSource {
  return {
    async listEpics() {
      return opts.epics;
    },
    async listAll() {
      return opts.all;
    },
    async showSpecId(featureId) {
      return opts.specIds[featureId] ?? null;
    },
    async listBeads(ids) {
      return opts.linkBeads.filter((b) => ids.includes(b.id));
    },
    async listReady() {
      const ready = new Set(opts.readyIds ?? []);
      return opts.linkBeads.filter((b) => ready.has(b.id));
    },
  };
}

describe("classifySpecStatus", () => {
  it("classifies live / archived / missing", () => {
    const root = makeProject({
      live: { alive: "[beads:x]" },
      archived: { "2026-01-01-gone": "[beads:y]" },
    });
    try {
      expect(classifySpecStatus(root, "alive")).toBe("active");
      expect(classifySpecStatus(root, "gone")).toBe("archived");
      expect(classifySpecStatus(root, "nowhere")).toBe("missing");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("computeRoadmap", () => {
  it("returns [] when the project has no .beads/", async () => {
    const root = makeProject({ beads: false });
    try {
      const source = fakeSource({ epics: [], all: [], specIds: {}, linkBeads: [] });
      expect(await computeRoadmap(root, source)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("aggregates a capability with two proposals' progress", async () => {
    const root = makeProject({
      live: {
        "proposal-a": "<!-- beads:feature:f-a -->\n[beads:a1]\n[beads:a2]",
        "proposal-b": "<!-- beads:feature:f-b -->\n[beads:b1]",
      },
    });
    try {
      const source = fakeSource({
        epics: [
          { id: "epic1", title: "[CAPABILITY] roadmap-thing", status: "open" },
          { id: "epic-other", title: "not a capability", status: "open" },
        ],
        all: [
          { id: "f-a", parent: "epic1", issue_type: "feature" },
          { id: "f-b", parent: "epic1", issue_type: "feature" },
        ],
        specIds: { "f-a": "proposal-a", "f-b": "proposal-b" },
        linkBeads: [
          { id: "f-a", status: "open", issue_type: "feature" },
          { id: "f-b", status: "open", issue_type: "feature" },
          { id: "a1", status: "closed", issue_type: "task" },
          { id: "a2", status: "open", issue_type: "task" },
          { id: "b1", status: "closed", issue_type: "task" },
        ],
      });
      const caps = await computeRoadmap(root, source);
      expect(caps).toHaveLength(1); // only the [CAPABILITY] epic
      const cap = caps[0]!;
      expect(cap.name).toBe("roadmap-thing");
      expect(cap.epicId).toBe("epic1");
      expect(cap.proposals.map((p) => p.slug).sort()).toEqual([
        "proposal-a",
        "proposal-b",
      ]);
      // a1+b1 closed of a1,a2,b1 total
      expect(cap.progress.totalTasks).toBe(3);
      expect(cap.progress.closedTasks).toBe(2);
      const a = cap.proposals.find((p) => p.slug === "proposal-a")!;
      expect(a.specStatus).toBe("active");
      expect(a.rollup.tasks.total).toBe(2);
      expect(a.rollup.tasks.closed).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("classifies a feature bead pointing at an archived proposal (not dropped)", async () => {
    const root = makeProject({
      archived: { "2026-02-02-archived-one": "<!-- beads:feature:f-arch -->\n[beads:z1]" },
    });
    try {
      const source = fakeSource({
        epics: [{ id: "epicA", title: "[CAPABILITY] cap-a", status: "open" }],
        all: [{ id: "f-arch", parent: "epicA", issue_type: "feature" }],
        specIds: { "f-arch": "archived-one" },
        linkBeads: [
          { id: "f-arch", status: "open", issue_type: "feature" },
          { id: "z1", status: "closed", issue_type: "task" },
        ],
      });
      const caps = await computeRoadmap(root, source);
      expect(caps).toHaveLength(1);
      const proposals = caps[0]!.proposals;
      expect(proposals).toHaveLength(1); // classified, not dropped
      expect(proposals[0]!.slug).toBe("archived-one");
      expect(proposals[0]!.specStatus).toBe("archived");
      // rollup computed from the archived tasks.md
      expect(proposals[0]!.rollup.tasks.total).toBe(1);
      expect(proposals[0]!.rollup.tasks.closed).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips feature beads with no resolvable spec_id", async () => {
    const root = makeProject({ live: {} });
    try {
      const source = fakeSource({
        epics: [{ id: "e", title: "[CAPABILITY] c", status: "open" }],
        all: [{ id: "f-nospec", parent: "e", issue_type: "feature" }],
        specIds: {}, // no spec_id
        linkBeads: [],
      });
      const caps = await computeRoadmap(root, source);
      expect(caps[0]!.proposals).toEqual([]);
      expect(caps[0]!.progress).toEqual({ totalTasks: 0, closedTasks: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
