/**
 * Beads filesystem-watcher tests (add-project-status-snapshots, task 4.1).
 *
 * Coverage backfill for already-landed logic (the API batch shipped
 * beads-watcher.ts). Six seams from the spec's Testing table:
 *
 *   1. Debounce — a burst of rapid rename-over rewrites within the 300ms
 *      window collapses to exactly ONE recount, not one-per-write.
 *   2. Poll fallback — with NO fs.watch established (the `.beads/` dir is
 *      absent at start, so the watcher goes poll-only), the poll path still
 *      picks up a file that appears later.
 *   3. Missing `.beads/` skips cleanly — no throw, that project produces no
 *      recount, sibling projects are unaffected.
 *   4. Malformed JSONL keeps previous counts — `parseIssuesJsonl` returns
 *      `null` on any bad line and `computeBeadCountsFromDisk` propagates that
 *      as fail-open `null` (caller keeps its last-good counts).
 *   5. Derivation parity — the JSONL-based recount (`deriveUnlinkedCounts`)
 *      and the live `beads-unlinked` route's shared bead-rollup derivation
 *      (`filterUnlinked` + `deriveBlockedIds`) report IDENTICAL ready/blocked
 *      unlinked totals for the same fixture. One derivation source, no fork.
 *   6. BeadTransition — `recordProjectStatusFromBeads` (the beads-watcher's
 *      default recount sink) emits exactly one `BeadTransition` on a genuine
 *      count change and stays silent on a no-change recompute.
 *
 * Determinism notes:
 *   - Tests 1 & 2 are the only ones touching real fs.watch / timers; they use
 *     a short debounce/poll and generous post-write waits, and assert on the
 *     COUNT of recounts that observed the new value (so a stray event can't
 *     flip the result). Every other test drives pure functions or the sink
 *     directly.
 *   - Test 6 uses a hand-rolled fake `Db` (no live Postgres) that satisfies
 *     the two query shapes `recordProjectStatusFromBeads` needs, so the
 *     BeadTransition emission gate is exercised deterministically without the
 *     PG-gated route harness (that lives in task 4.2).
 */

import {
  describe,
  test,
  expect,
  afterEach,
} from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { Db } from "@nexus/db";
import type { BeadUnlinkedCounts } from "@nexus/core";
import {
  parseIssuesJsonl,
  computeBeadCountsFromDisk,
  deriveUnlinkedCounts,
  startBeadsWatcher,
  type BeadsWatcherHandle,
  type BeadsWatcherProject,
} from "./beads-watcher";
import {
  deriveBlockedIds,
  filterUnlinked,
  type RawBead,
} from "./bead-rollup";
import { recordProjectStatusFromBeads } from "./status-snapshots";
import { lifecycleBus, type LifecycleEnvelope } from "./lifecycle-bus";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Create an isolated temp project root under os.tmpdir(). */
function makeTempProject(): string {
  return mkdtempSync(join(tmpdir(), "beads-watcher-"));
}

/** Serialize beads to the `.beads/issues.jsonl` full-dump export shape. */
function toJsonl(beads: RawBead[]): string {
  return beads.map((b) => JSON.stringify(b)).join("\n") + "\n";
}

/** Write `.beads/issues.jsonl` under a project (creating `.beads/`). */
function writeIssues(projectPath: string, beads: RawBead[]): void {
  const beadsDir = join(projectPath, ".beads");
  mkdirSync(beadsDir, { recursive: true });
  writeFileSync(join(beadsDir, "issues.jsonl"), toJsonl(beads));
}

/**
 * Atomic rename-over rewrite, exactly as `bd`'s `export.auto` does: write a
 * temp file then rename it onto `issues.jsonl` (invalidates a single-file
 * inotify watch; the watcher's directory watch survives).
 */
function renameOverIssues(projectPath: string, beads: RawBead[], tag: string): void {
  const beadsDir = join(projectPath, ".beads");
  const tmp = join(beadsDir, `.issues.jsonl.tmp.${tag}`);
  writeFileSync(tmp, toJsonl(beads));
  renameSync(tmp, join(beadsDir, "issues.jsonl"));
}

// Track live watchers + temp dirs for teardown so timers/watches never leak.
const openHandles: BeadsWatcherHandle[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  while (openHandles.length) openHandles.pop()!.stop();
  while (tempDirs.length) {
    try {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function track(dir: string): string {
  tempDirs.push(dir);
  return dir;
}
function startTracked(deps: Parameters<typeof startBeadsWatcher>[0]): BeadsWatcherHandle {
  const h = startBeadsWatcher(deps);
  openHandles.push(h);
  return h;
}

interface RecountCall {
  project: string;
  counts: BeadUnlinkedCounts;
}

// ─── 1. Debounce: burst of rename-overs → one recount ────────────────────────

describe("beads-watcher debounce", () => {
  test(
    "a burst of rename-over rewrites triggers exactly one recount",
    async () => {
      const proj = track(makeTempProject());
      writeIssues(proj, [{ id: "b1", status: "open" }]); // baseline: 1 ready

      const calls: RecountCall[] = [];
      startTracked({
        listProjects: (): BeadsWatcherProject[] => [{ code: "P", path: proj }],
        onRecount: (project, counts) => calls.push({ project, counts }),
        debounceMs: 150,
        pollIntervalMs: 100_000, // poll effectively disabled for this test
      });

      // Let the initial recount + the directory watch establish.
      await sleep(150);

      // Fire a rapid burst — all writes land the SAME new content (2 ready)
      // well inside the 150ms debounce window.
      for (let i = 0; i < 4; i++) {
        renameOverIssues(
          proj,
          [
            { id: "b1", status: "open" },
            { id: "b2", status: "open" },
          ],
          String(i),
        );
      }

      // Wait past the debounce so the single collapsed recount fires.
      await sleep(500);

      // Debounce invariant: 4 writes produced exactly ONE recount that
      // observed the new value (ready: 2), not four.
      const sawTwoReady = calls.filter(
        (c) => c.counts.beadsReadyUnlinked === 2,
      );
      expect(sawTwoReady).toHaveLength(1);
    },
    { timeout: 10_000 },
  );
});

// ─── 2. Poll fallback fires with no fs.watch ─────────────────────────────────

describe("beads-watcher poll fallback", () => {
  test(
    "poll path recounts a file that appears after start (no fs.watch established)",
    async () => {
      // No `.beads/` at start → `stat(beadsDir)` fails → watcher goes
      // poll-only, so ANY recount here can only come from the poll timer.
      const proj = track(makeTempProject());

      const calls: RecountCall[] = [];
      startTracked({
        listProjects: (): BeadsWatcherProject[] => [{ code: "P", path: proj }],
        onRecount: (project, counts) => calls.push({ project, counts }),
        debounceMs: 100_000, // debounce disabled — isolate the poll path
        pollIntervalMs: 80,
      });

      // Create the export only AFTER start, so the initial recount saw nothing
      // and no directory watch exists. Only the poll can surface this.
      await sleep(120);
      writeIssues(proj, [
        { id: "b1", status: "open" },
        { id: "b2", status: "open" },
      ]);

      // Several poll cycles.
      await sleep(400);

      const sawCounts = calls.filter(
        (c) => c.counts.beadsReadyUnlinked === 2,
      );
      expect(sawCounts.length).toBeGreaterThanOrEqual(1);
    },
    { timeout: 10_000 },
  );
});

// ─── 3. Missing `.beads/` skips cleanly, siblings unaffected ─────────────────

describe("beads-watcher missing .beads", () => {
  test("computeBeadCountsFromDisk returns null when .beads/ is absent", () => {
    const proj = track(makeTempProject()); // no .beads
    expect(computeBeadCountsFromDisk(proj)).toBeNull();
  });

  test(
    "a project without .beads/ produces no recount; a sibling with .beads/ still counts",
    async () => {
      const withBeads = track(makeTempProject());
      writeIssues(withBeads, [{ id: "b1", status: "open" }]);
      const noBeads = track(makeTempProject()); // intentionally empty

      const calls: RecountCall[] = [];
      // Must not throw when a project lacks `.beads/`.
      startTracked({
        listProjects: (): BeadsWatcherProject[] => [
          { code: "HAS", path: withBeads },
          { code: "NONE", path: noBeads },
        ],
        onRecount: (project, counts) => calls.push({ project, counts }),
        debounceMs: 150,
        pollIntervalMs: 100_000,
      });

      await sleep(200);

      expect(calls.some((c) => c.project === "NONE")).toBe(false);
      expect(
        calls.some(
          (c) => c.project === "HAS" && c.counts.beadsReadyUnlinked === 1,
        ),
      ).toBe(true);
    },
    { timeout: 10_000 },
  );
});

// ─── 4. Malformed JSONL keeps previous counts (fail-open) ────────────────────

describe("beads-watcher malformed JSONL", () => {
  test("parseIssuesJsonl returns null on any malformed line", () => {
    const good = toJsonl([{ id: "b1", status: "open" }]);
    expect(parseIssuesJsonl(good)).not.toBeNull();
    expect(parseIssuesJsonl(good)).toHaveLength(1);

    const bad = `${JSON.stringify({ id: "b1", status: "open" })}\n{not valid json\n`;
    expect(parseIssuesJsonl(bad)).toBeNull();
  });

  test("computeBeadCountsFromDisk returns null on malformed issues.jsonl", () => {
    const proj = track(makeTempProject());
    const beadsDir = join(proj, ".beads");
    mkdirSync(beadsDir, { recursive: true });
    // Truncated mid-write line → whole read is fail-open null.
    writeFileSync(join(beadsDir, "issues.jsonl"), '{"id":"b1","stat');
    expect(computeBeadCountsFromDisk(proj)).toBeNull();
  });
});

// ─── 5. Derivation parity with the live beads-unlinked route ─────────────────

describe("beads-watcher derivation parity", () => {
  test(
    "JSONL recount matches the shared bead-rollup derivation on the same fixture",
    () => {
      // Fixture spanning the whole surface:
      //   b1 open, unlinked, no deps            -> ready
      //   b2 open, unlinked, blocks-dep on b3   -> blocked (b3 open/unclosed)
      //   b3 open, LINKED (blocker)             -> excluded from unlinked
      //   b4 closed, unlinked                   -> excluded (closed)
      //   b5 in_progress, unlinked, no deps     -> ready
      const beads: RawBead[] = [
        { id: "b1", status: "open" },
        {
          id: "b2",
          status: "open",
          dependencies: [{ depends_on_id: "b3", type: "blocks" }],
        },
        { id: "b3", status: "open" },
        { id: "b4", status: "closed" },
        { id: "b5", status: "in_progress" },
      ];
      const linked = new Set(["b3"]);

      // JSONL path (beads-watcher) — parse then derive.
      const parsed = parseIssuesJsonl(toJsonl(beads));
      expect(parsed).not.toBeNull();
      const jsonlCounts = deriveUnlinkedCounts(parsed!, linked);

      // Live path (beads-unlinked route) — the route pulls open+in_progress
      // via `bd list` then splits with the SAME bead-rollup primitives.
      const open = beads.filter(
        (b) => b.status === "open" || b.status === "in_progress",
      );
      const blockedIds = deriveBlockedIds(open);
      const unlinked = filterUnlinked(open, linked);
      let ready = 0;
      let blocked = 0;
      for (const b of unlinked) {
        if (blockedIds.has(b.id)) blocked++;
        else ready++;
      }
      const liveCounts: BeadUnlinkedCounts = {
        beadsReadyUnlinked: ready,
        beadsBlockedUnlinked: blocked,
      };

      // Concrete expectation AND parity.
      expect(jsonlCounts).toEqual({
        beadsReadyUnlinked: 2,
        beadsBlockedUnlinked: 1,
      });
      expect(jsonlCounts).toEqual(liveCounts);
    },
  );
});

// ─── 6. BeadTransition: once on change, silent on no-change ───────────────────

/**
 * Minimal fake `Db` satisfying the two query shapes
 * `recordProjectStatusFromBeads` uses: a `select().from().where().orderBy()
 * .limit()` read (resolving to the latest row, or none) and an
 * `insert().values()` write (captured).
 */
function fakeDb(latest: {
  proposalsUnarchived: number;
  beadsReadyUnlinked: number;
  beadsBlockedUnlinked: number;
} | null): { db: Db; inserts: unknown[] } {
  const inserts: unknown[] = [];
  const selectBuilder = {
    from() {
      return this;
    },
    where() {
      return this;
    },
    orderBy() {
      return this;
    },
    limit() {
      return Promise.resolve(latest ? [latest] : []);
    },
  };
  const db = {
    select: () => selectBuilder,
    insert: () => ({
      values: (v: unknown) => {
        inserts.push(v);
        return Promise.resolve();
      },
    }),
  } as unknown as Db;
  return { db, inserts };
}

function collectBeadTransitions(project: string): {
  received: LifecycleEnvelope<"BeadTransition">[];
  stop: () => void;
} {
  const received: LifecycleEnvelope<"BeadTransition">[] = [];
  const handler = (env: LifecycleEnvelope<"BeadTransition">): void => {
    if (env.payload.project === project) received.push(env);
  };
  lifecycleBus.on("BeadTransition", handler);
  return { received, stop: () => lifecycleBus.off("BeadTransition", handler) };
}

describe("beads-watcher BeadTransition emission", () => {
  test("emits exactly one BeadTransition on a genuine count change", async () => {
    const { db, inserts } = fakeDb(null); // no prior row → previous {0,0}
    const sub = collectBeadTransitions("nx");
    try {
      const changed = await recordProjectStatusFromBeads(db, "nx", {
        beadsReadyUnlinked: 3,
        beadsBlockedUnlinked: 1,
      });
      expect(changed).toBe(true);
      expect(inserts).toHaveLength(1);
      expect(sub.received).toHaveLength(1);
      expect(sub.received[0]!.payload.previous).toEqual({
        beadsReadyUnlinked: 0,
        beadsBlockedUnlinked: 0,
      });
      expect(sub.received[0]!.payload.current).toEqual({
        beadsReadyUnlinked: 3,
        beadsBlockedUnlinked: 1,
      });
    } finally {
      sub.stop();
    }
  });

  test("is silent (no emit, no insert) when the counts are unchanged", async () => {
    const { db, inserts } = fakeDb({
      proposalsUnarchived: 2,
      beadsReadyUnlinked: 3,
      beadsBlockedUnlinked: 1,
    });
    const sub = collectBeadTransitions("nx");
    try {
      const changed = await recordProjectStatusFromBeads(db, "nx", {
        beadsReadyUnlinked: 3,
        beadsBlockedUnlinked: 1,
      });
      expect(changed).toBe(false);
      expect(inserts).toHaveLength(0);
      expect(sub.received).toHaveLength(0);
    } finally {
      sub.stop();
    }
  });
});
