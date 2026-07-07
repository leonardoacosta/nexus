/**
 * bead-rollup tests (add-bead-proposal-roadmap-surface task 1.9).
 *
 * The pure aggregation core (parseBeadMarkers / deriveBlockedIds /
 * aggregateRollup / filterUnlinked) is tested directly — no bd, no mocks.
 * `computeBeadRollup` is exercised against a tmpdir fixture with an injected
 * fake bead source (the DI seam), so it never shells to `bd`.
 */

import { describe, it, expect, spyOn, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseBeadMarkers,
  deriveBlockedIds,
  aggregateRollup,
  filterUnlinked,
  computeBeadRollup,
  computeRollupsForProject,
  collectLinkedBeadIds,
  emptyRollup,
  defaultRollupBeadSource,
  type RawBead,
  type RollupBeadSource,
} from "./bead-rollup";
import * as exec from "../utils/exec";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeProject(opts: {
  beads?: boolean;
  specs?: Record<string, string>; // specName -> tasks.md body
  archived?: Record<string, string>; // "date-slug" -> tasks.md body
}): string {
  const root = mkdtempSync(join(tmpdir(), "nx-rollup-"));
  if (opts.beads !== false) mkdirSync(join(root, ".beads"), { recursive: true });
  for (const [name, body] of Object.entries(opts.specs ?? {})) {
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

/** Build a fake source from a fixed bead list + ready-id set. */
function fakeSource(beads: RawBead[], readyIds: string[] = []): RollupBeadSource {
  const ready = beads.filter((b) => readyIds.includes(b.id));
  return {
    async listBeads(ids) {
      return beads.filter((b) => ids.includes(b.id));
    },
    async listReady() {
      return ready;
    },
  };
}

const MARKED_TASKS = `<!-- beads:epic:nx-epic1 -->
<!-- beads:feature:nx-feat1 -->

# Tasks

- [x] 1.1 first [beads:nx-t1]
- [ ] 1.2 second [beads:nx-t2]
- [ ] 1.3 third [beads:nx-t3]
`;

// ---------------------------------------------------------------------------
// parseBeadMarkers
// ---------------------------------------------------------------------------

describe("parseBeadMarkers", () => {
  it("extracts epic, feature, and task ids", () => {
    const m = parseBeadMarkers(MARKED_TASKS);
    expect(m.epicId).toBe("nx-epic1");
    expect(m.featureId).toBe("nx-feat1");
    expect(m.taskIds).toEqual(["nx-t1", "nx-t2", "nx-t3"]);
  });

  it("returns nulls and empty tasks for a marker-less body", () => {
    const m = parseBeadMarkers("# Tasks\n\n- [ ] no markers here\n");
    expect(m.epicId).toBeNull();
    expect(m.featureId).toBeNull();
    expect(m.taskIds).toEqual([]);
  });

  it("de-duplicates repeated task ids in first-seen order", () => {
    const m = parseBeadMarkers("[beads:nx-a] [beads:nx-b] [beads:nx-a]");
    expect(m.taskIds).toEqual(["nx-a", "nx-b"]);
  });
});

// ---------------------------------------------------------------------------
// deriveBlockedIds
// ---------------------------------------------------------------------------

describe("deriveBlockedIds", () => {
  it("flags status=blocked beads", () => {
    const blocked = deriveBlockedIds([{ id: "x", status: "blocked" }]);
    expect(blocked.has("x")).toBe(true);
  });

  it("flags a task with an unclosed blocks dependency", () => {
    const beads: RawBead[] = [
      {
        id: "t1",
        status: "open",
        dependencies: [{ depends_on_id: "t2", type: "blocks" }],
      },
      { id: "t2", status: "open" },
    ];
    const blocked = deriveBlockedIds(beads);
    expect(blocked.has("t1")).toBe(true);
    expect(blocked.has("t2")).toBe(false);
  });

  it("does NOT flag a task whose blocker is closed", () => {
    const beads: RawBead[] = [
      {
        id: "t1",
        status: "open",
        dependencies: [{ depends_on_id: "t2", type: "blocks" }],
      },
      { id: "t2", status: "closed" },
    ];
    expect(deriveBlockedIds(beads).has("t1")).toBe(false);
  });

  it("ignores parent-child and related edges", () => {
    const beads: RawBead[] = [
      {
        id: "t1",
        status: "open",
        dependencies: [
          { depends_on_id: "epic", type: "parent-child" },
          { depends_on_id: "other", type: "related" },
        ],
      },
      { id: "epic", status: "open" },
      { id: "other", status: "open" },
    ];
    expect(deriveBlockedIds(beads).has("t1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// aggregateRollup
// ---------------------------------------------------------------------------

describe("aggregateRollup", () => {
  it("resolves epic/feature and counts task states", () => {
    const markers = parseBeadMarkers(MARKED_TASKS);
    const beads: RawBead[] = [
      { id: "nx-epic1", status: "open", issue_type: "epic", priority: 2, title: "Epic" },
      { id: "nx-feat1", status: "open", issue_type: "feature", priority: 2, title: "Feature" },
      { id: "nx-t1", status: "closed", issue_type: "task", priority: 2, title: "t1" },
      { id: "nx-t2", status: "open", issue_type: "task", priority: 2, title: "t2" },
      { id: "nx-t3", status: "open", issue_type: "task", priority: 2, title: "t3" },
    ];
    const rollup = aggregateRollup(markers, beads, new Set(["nx-t2"]));

    expect(rollup.epic?.id).toBe("nx-epic1");
    expect(rollup.feature?.id).toBe("nx-feat1");
    expect(rollup.tasks.total).toBe(3); // task beads only, epic+feature excluded
    expect(rollup.tasks.closed).toBe(1);
    expect(rollup.tasks.ready).toBe(1); // nx-t2 in ready set
    expect(rollup.tasks.blocked).toBe(0);
    expect(rollup.beads).toHaveLength(5); // full linked set for the detail view
  });

  it("counts only beads bd actually returned (missing/renamed drop out)", () => {
    const markers = parseBeadMarkers(MARKED_TASKS);
    // bd returns only 2 of the 3 task beads (nx-t3 was deleted).
    const beads: RawBead[] = [
      { id: "nx-t1", status: "closed", issue_type: "task" },
      { id: "nx-t2", status: "open", issue_type: "task" },
    ];
    const rollup = aggregateRollup(markers, beads, new Set());
    expect(rollup.tasks.total).toBe(2);
    expect(rollup.tasks.closed).toBe(1);
    expect(rollup.epic).toBeNull(); // epic bead not returned
    expect(rollup.feature).toBeNull();
  });

  it("blocked-by-dependency task is counted blocked and excluded from ready", () => {
    const markers = parseBeadMarkers("[beads:t1] [beads:t2]");
    const beads: RawBead[] = [
      {
        id: "t1",
        status: "open",
        issue_type: "task",
        dependencies: [{ depends_on_id: "t2", type: "blocks" }],
      },
      { id: "t2", status: "open", issue_type: "task" },
    ];
    // bd `ready` would never include a blocked task, so readyIds omits t1.
    const rollup = aggregateRollup(markers, beads, new Set(["t2"]));
    expect(rollup.tasks.blocked).toBe(1);
    expect(rollup.tasks.ready).toBe(1); // only t2
  });

  it("empty markers yield a zeroed rollup", () => {
    const rollup = aggregateRollup(
      { epicId: null, featureId: null, taskIds: [] },
      [],
      new Set(),
    );
    expect(rollup).toEqual(emptyRollup());
  });
});

// ---------------------------------------------------------------------------
// filterUnlinked
// ---------------------------------------------------------------------------

describe("filterUnlinked", () => {
  it("excludes referenced beads and includes ad-hoc ones", () => {
    const open: RawBead[] = [
      { id: "nx-linked", status: "open", issue_type: "task", title: "linked" },
      { id: "nx-adhoc", status: "open", issue_type: "bug", title: "ad-hoc" },
    ];
    const linked = new Set(["nx-linked"]);
    const out = filterUnlinked(open, linked);
    expect(out.map((b) => b.id)).toEqual(["nx-adhoc"]);
    expect(out[0]).toMatchObject({ id: "nx-adhoc", type: "bug", title: "ad-hoc" });
  });
});

// ---------------------------------------------------------------------------
// collectLinkedBeadIds
// ---------------------------------------------------------------------------

describe("collectLinkedBeadIds", () => {
  it("unions ids across live proposals and skips archive/", () => {
    const root = makeProject({
      specs: {
        one: "<!-- beads:epic:e1 -->\n<!-- beads:feature:f1 -->\n[beads:t1]",
        two: "<!-- beads:feature:f2 -->\n[beads:t2]",
      },
      archived: {
        "2026-01-01-old": "<!-- beads:feature:f-archived -->\n[beads:t-archived]",
      },
    });
    try {
      const linked = collectLinkedBeadIds(root);
      expect(linked.has("e1")).toBe(true);
      expect(linked.has("f1")).toBe(true);
      expect(linked.has("t1")).toBe(true);
      expect(linked.has("f2")).toBe(true);
      expect(linked.has("t2")).toBe(true);
      // Archived proposals are NOT scanned.
      expect(linked.has("f-archived")).toBe(false);
      expect(linked.has("t-archived")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// computeBeadRollup — IO orchestrator (fake source)
// ---------------------------------------------------------------------------

describe("computeBeadRollup", () => {
  it("returns null when the project has no .beads/ directory", async () => {
    const root = makeProject({ beads: false, specs: { s: MARKED_TASKS } });
    try {
      expect(await computeBeadRollup(root, "s")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns null when tasks.md cannot be resolved", async () => {
    const root = makeProject({ specs: {} });
    try {
      expect(await computeBeadRollup(root, "does-not-exist")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns a zeroed rollup for empty markers (bd reachable)", async () => {
    const root = makeProject({ specs: { s: "# Tasks\n- [ ] no markers\n" } });
    try {
      const rollup = await computeBeadRollup(root, "s", fakeSource([]));
      expect(rollup).toEqual(emptyRollup());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("aggregates counts from the injected source", async () => {
    const root = makeProject({ specs: { s: MARKED_TASKS } });
    try {
      const beads: RawBead[] = [
        { id: "nx-epic1", status: "open", issue_type: "epic", title: "Epic" },
        { id: "nx-feat1", status: "open", issue_type: "feature", title: "Feature" },
        { id: "nx-t1", status: "closed", issue_type: "task" },
        { id: "nx-t2", status: "open", issue_type: "task" },
        { id: "nx-t3", status: "open", issue_type: "task" },
      ];
      const rollup = await computeBeadRollup(root, "s", fakeSource(beads, ["nx-t2", "nx-t3"]));
      expect(rollup).not.toBeNull();
      expect(rollup!.epic?.id).toBe("nx-epic1");
      expect(rollup!.tasks.total).toBe(3);
      expect(rollup!.tasks.closed).toBe(1);
      expect(rollup!.tasks.ready).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns null when the source throws", async () => {
    const root = makeProject({ specs: { s: MARKED_TASKS } });
    const throwing: RollupBeadSource = {
      async listBeads() {
        throw new Error("bd exploded");
      },
      async listReady() {
        return [];
      },
    };
    try {
      expect(await computeBeadRollup(root, "s", throwing)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves an archived tasks.md when no live dir exists", async () => {
    const root = makeProject({
      archived: { "2026-01-01-gone": "[beads:nx-a1]" },
    });
    try {
      const rollup = await computeBeadRollup(
        root,
        "gone",
        fakeSource([{ id: "nx-a1", status: "closed", issue_type: "task" }]),
      );
      expect(rollup).not.toBeNull();
      expect(rollup!.tasks.total).toBe(1);
      expect(rollup!.tasks.closed).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// defaultRollupBeadSource — real `bd` arg strings (regression for the missing
// `--all` flag that silently zeroed every rollup's `closed`/`total`).
//
// The DI-fake tests above never exercise the real arg array, so the dropped
// `--all` shipped undetected. This spies on the exec layer and asserts the
// actual flags, so a future regression fails locally.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// computeRollupsForProject — the batched entry point (nx-fndhz).
//
// The headline invariant: N specs -> exactly ONE `bd list` + ONE `bd ready`
// for the whole project, not a per-spec fan-out. Plus correct per-spec
// partitioning from the shared maps.
// ---------------------------------------------------------------------------

describe("computeRollupsForProject", () => {
  afterEach(() => {
    spyOn(exec, "execJson").mockRestore();
  });

  it("issues exactly ONE bd list + ONE bd ready for N specs (deduped union)", async () => {
    const root = makeProject({
      specs: {
        s1: "<!-- beads:feature:nx-f1 -->\n[beads:nx-t1]\n[beads:nx-shared]",
        s2: "<!-- beads:feature:nx-f2 -->\n[beads:nx-t2]\n[beads:nx-shared]",
        s3: "<!-- beads:feature:nx-f3 -->\n[beads:nx-t3]",
      },
    });
    const spy = spyOn(exec, "execJson").mockResolvedValue([] as RawBead[]);
    try {
      await computeRollupsForProject(root, ["s1", "s2", "s3"]);

      const listCalls = spy.mock.calls.filter((c) => c[1][0] === "list");
      const readyCalls = spy.mock.calls.filter((c) => c[1][0] === "ready");
      // The whole point: one list + one ready for THREE specs.
      expect(listCalls).toHaveLength(1);
      expect(readyCalls).toHaveLength(1);

      const [, args] = listCalls[0]!;
      expect(args).toContain("--all"); // closed-inclusive flag preserved
      const csv = args[2] as string;
      const ids = csv.split(",");
      // nx-shared appears in s1 and s2 but must be deduped to a single id.
      expect(ids.filter((i) => i === "nx-shared")).toHaveLength(1);
      // all six distinct ids present.
      expect(new Set(ids)).toEqual(
        new Set(["nx-f1", "nx-t1", "nx-shared", "nx-f2", "nx-t2", "nx-f3", "nx-t3"]),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("partitions the shared bead set per spec (no cross-spec leak)", async () => {
    const root = makeProject({
      specs: {
        withMarkers: MARKED_TASKS, // epic1/feat1/t1,t2,t3
        shared: "[beads:nx-t1]", // shares nx-t1 with withMarkers
        noMarkers: "# Tasks\n- [ ] nothing here\n",
        // "gone" has no tasks.md at all.
      },
    });
    try {
      const beads: RawBead[] = [
        { id: "nx-epic1", status: "open", issue_type: "epic", title: "Epic" },
        { id: "nx-feat1", status: "open", issue_type: "feature", title: "Feature" },
        { id: "nx-t1", status: "closed", issue_type: "task" },
        { id: "nx-t2", status: "open", issue_type: "task" },
        { id: "nx-t3", status: "open", issue_type: "task" },
      ];
      const m = await computeRollupsForProject(
        root,
        ["withMarkers", "shared", "noMarkers", "gone"],
        fakeSource(beads, ["nx-t2"]),
      );

      // withMarkers -> full rollup, only its OWN 5 linked beads.
      const wm = m.get("withMarkers")!;
      expect(wm).not.toBeNull();
      expect(wm!.tasks.total).toBe(3);
      expect(wm!.tasks.closed).toBe(1);
      expect(wm!.tasks.ready).toBe(1); // nx-t2
      expect(wm!.beads).toHaveLength(5);

      // shared -> ONLY nx-t1 (partitioned; NOT polluted by withMarkers' beads).
      const sh = m.get("shared")!;
      expect(sh).not.toBeNull();
      expect(sh!.tasks.total).toBe(1);
      expect(sh!.tasks.closed).toBe(1);
      expect(sh!.beads).toHaveLength(1);
      expect(sh!.beads[0]!.id).toBe("nx-t1");

      // noMarkers -> zeroed rollup (bd reachable, nothing to fold).
      expect(m.get("noMarkers")).toEqual(emptyRollup());

      // gone -> null (tasks.md unresolvable).
      expect(m.get("gone")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("maps every spec to null when the project has no .beads/ dir", async () => {
    const root = makeProject({ beads: false, specs: { a: MARKED_TASKS, b: MARKED_TASKS } });
    try {
      const m = await computeRollupsForProject(root, ["a", "b"]);
      expect(m.get("a")).toBeNull();
      expect(m.get("b")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does NOT spawn bd when the id union is empty", async () => {
    const root = makeProject({ specs: { a: "# no markers\n", b: "# also none\n" } });
    const spy = spyOn(exec, "execJson").mockResolvedValue([] as RawBead[]);
    try {
      const m = await computeRollupsForProject(root, ["a", "b"]);
      expect(spy).not.toHaveBeenCalled();
      expect(m.get("a")).toEqual(emptyRollup());
      expect(m.get("b")).toEqual(emptyRollup());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("degrades every marker-parsed spec to null on bd failure", async () => {
    const root = makeProject({ specs: { s: MARKED_TASKS } });
    const throwing: RollupBeadSource = {
      async listBeads() {
        throw new Error("bd exploded");
      },
      async listReady() {
        return [];
      },
    };
    try {
      const m = await computeRollupsForProject(root, ["s"], throwing);
      expect(m.get("s")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("defaultRollupBeadSource — bd arg strings", () => {
  afterEach(() => {
    // Restore the spy so the module binding is not left mutated for other
    // suites in a full-suite run (bun mock forward-leak guard).
    spyOn(exec, "execJson").mockRestore();
  });

  it("listBeads passes --all so closed beads are returned", async () => {
    const spy = spyOn(exec, "execJson").mockResolvedValue([] as RawBead[]);

    await defaultRollupBeadSource.listBeads(["nx-a", "nx-b"], "/tmp/proj");

    expect(spy).toHaveBeenCalledTimes(1);
    const [cmd, args] = spy.mock.calls[0]!;
    expect(cmd).toBe("bd");
    expect(args).toEqual(["list", "--id", "nx-a,nx-b", "--all", "--json"]);
    // Guard the exact intent: the closed-inclusive flag is present.
    expect(args).toContain("--all");
  });

  it("listBeads short-circuits (no bd spawn) for an empty id set", async () => {
    const spy = spyOn(exec, "execJson").mockResolvedValue([] as RawBead[]);

    const out = await defaultRollupBeadSource.listBeads([], "/tmp/proj");

    expect(out).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("listReady stays open-only — never leaks --all into bd ready", async () => {
    const spy = spyOn(exec, "execJson").mockResolvedValue([] as RawBead[]);

    await defaultRollupBeadSource.listReady("/tmp/proj");

    const [cmd, args] = spy.mock.calls[0]!;
    expect(cmd).toBe("bd");
    expect(args).toEqual(["ready", "--json"]);
    expect(args).not.toContain("--all");
  });
});
