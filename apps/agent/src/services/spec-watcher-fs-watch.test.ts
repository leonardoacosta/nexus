/**
 * Spec-watcher targeted-refresh integration tests.
 *
 * Covers:
 *   - SpecB 5.2 (nx-hcm6): a tasks.md checkbox-count change surfaces a
 *     `progress` SpecTransition on the lifecycle bus. The test asserts the
 *     transition FIRES with the correct payload (completed/total) — it does
 *     not enforce a wall-clock latency bound, which is load-variable under CI
 *     and not a property a unit test can reliably assert.
 *   - SpecB 5.3 (nx-rcu9): when a spec is "archived" (removed from the
 *     active `openspec/changes/` dir), the watcher emits a `removed`
 *     SpecTransition.
 *
 * Determinism note (nx-yyy62 root fix):
 *   These tests USED to trigger the refresh by writing tasks.md + creating a
 *   sentinel dir to fire the real OS `fs.watch`, then race a wall-clock
 *   deadline (≤8s) for the debounced re-poll to emit. Under heavy-test load
 *   (`NEXUS_HEAVY_TESTS=1 bun test`) that chain — real inotify event delivery
 *   + `WATCH_DEBOUNCE_MS` timer + mocked `openspec show` re-poll — exceeded 8s
 *   roughly 1-in-4 runs, flaking the suite (nx-yyy62).
 *
 *   The fix drives the watcher's targeted refresh DIRECTLY: `refreshSingleSpec`
 *   is the EXACT function the debounced fs.watch callback invokes
 *   (`scheduleSpecRefresh` → `refreshSingleSpec`). Calling it directly (via the
 *   state-threading adapter exported from `./spec-watcher`) exercises 100% of
 *   the production refresh logic — change detection, bus emission — while
 *   skipping only the non-deterministic OS event delivery + debounce timer.
 *   Emission is therefore synchronous-on-await: no wall-clock race, no flake.
 *
 * Strategy:
 *   - Build a temp openspec tree under `os.tmpdir()` — zero contact with
 *     real projects.
 *   - Inject the fixture project via `__setGetProjectsForTesting` (reversible;
 *     avoids Bun's process-global `mock.module` leakage).
 *   - Mock `../utils/exec#execText` so `openspec show <spec> --json` and
 *     `openspec list --json` resolve from in-memory fixture state without
 *     invoking the real openspec binary.
 *   - Seed `_projectState` via a firstTick `processProjectSpecs` call so the
 *     refresh has a baseline to diff against.
 *   - Mutate fixture state (toggle checkbox count) / rmdir the spec to
 *     simulate archive, then `await refreshSingleSpec(...)` and assert the
 *     emitted SpecTransition has the correct payload.
 *
 * Cleanup: `afterAll` resets the injected getProjects and removes the temp tree.
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  mock,
} from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── Fixture tree ───────────────────────────────────────────────────────────
//
// <tmp>/
//   └── openspec/
//       └── changes/
//           ├── test-spec-progress/
//           │   ├── proposal.md
//           │   └── tasks.md       (toggled by the test)
//           └── test-spec-archive/
//               ├── proposal.md
//               └── tasks.md       (whole dir rmdir'd by the test)

const BASE = mkdtempSync(join(tmpdir(), "spec-watcher-fs-"));
const PROJECT_CWD = BASE;
const PROJECT_CODE = "fixture-proj";
const CHANGES_DIR = join(BASE, "openspec", "changes");

const SPEC_PROGRESS = "test-spec-progress";
const SPEC_ARCHIVE = "test-spec-archive";
const SPEC_PROGRESS_DIR = join(CHANGES_DIR, SPEC_PROGRESS);
const SPEC_ARCHIVE_DIR = join(CHANGES_DIR, SPEC_ARCHIVE);
const SPEC_PROGRESS_TASKS = join(SPEC_PROGRESS_DIR, "tasks.md");

function tasksMarkdown(completed: number, total: number): string {
  const lines: string[] = ["# Tasks", ""];
  for (let i = 1; i <= total; i++) {
    const check = i <= completed ? "[x]" : "[ ]";
    lines.push(`- ${check} task ${i}`);
  }
  return lines.join("\n") + "\n";
}

// Track the "current" snapshot each spec should report when `openspec show`
// is mocked. Mutable so test bodies can update it alongside the on-disk
// tasks.md change.
const progressState = {
  completed: 2,
  total: 5,
};

// ─── Module mocks (BEFORE importing the subject) ────────────────────────────
//
// We use an injectable seam (__setGetProjectsForTesting) rather than
// mock.module("./config-loader") because Bun's module mocks are
// process-global and irreversible — they leaked into config-loader.test.ts
// and caused spurious failures there.

import {
  __setGetProjectsForTesting,
  __resetGetProjectsForTesting,
} from "./spec-watcher/poller";

__setGetProjectsForTesting(() => [
  { code: PROJECT_CODE, name: PROJECT_CODE, path: PROJECT_CWD },
]);

// Mock execText so `openspec show/list` reads our in-memory fixture state
// instead of spawning a real subprocess. Return JSON that matches the
// shape the watcher expects.
mock.module("../utils/exec", () => ({
  execText: async (cmd: string, args: string[]) => {
    if (cmd !== "openspec") {
      throw new Error(`unexpected cmd: ${cmd}`);
    }
    // `openspec show <specName> --json`
    if (args[0] === "show") {
      const specName = args[1];
      if (specName === SPEC_PROGRESS) {
        return JSON.stringify({
          name: SPEC_PROGRESS,
          status: "active",
          completedTasks: progressState.completed,
          totalTasks: progressState.total,
        });
      }
      if (specName === SPEC_ARCHIVE) {
        // When archived, `openspec show` returns empty array so the watcher
        // falls through to a full pollProjectSpecs() which observes the
        // directory is gone and emits `removed`.
        return JSON.stringify([]);
      }
      return JSON.stringify([]);
    }
    // `openspec list --json`
    if (args[0] === "list") {
      const specs: Array<{
        name: string;
        status: string;
        completedTasks: number;
        totalTasks: number;
      }> = [];
      // Progress spec still exists.
      specs.push({
        name: SPEC_PROGRESS,
        status: "active",
        completedTasks: progressState.completed,
        totalTasks: progressState.total,
      });
      // Archive spec: only include if its directory still exists.
      // `existsSync` is not imported here; rely on fs-watch test's archive
      // step to advance the archive state.
      if (archiveState.exists) {
        specs.push({
          name: SPEC_ARCHIVE,
          status: "active",
          completedTasks: 0,
          totalTasks: 3,
        });
      }
      return JSON.stringify(specs);
    }
    throw new Error(`unexpected openspec invocation: ${args.join(" ")}`);
  },
  execJson: async () => {
    throw new Error("execJson should not be called in this test");
  },
  ExecError: class ExecError extends Error {},
  ExecTimeoutError: class ExecTimeoutError extends Error {},
}));

const archiveState = { exists: true };

// ─── Import subject AFTER mocks ─────────────────────────────────────────────

import { lifecycleBus, type LifecycleEnvelope } from "./lifecycle-bus";
import {
  processProjectSpecs,
  refreshSingleSpec,
  _projectState,
} from "./spec-watcher";

// ─── Setup ──────────────────────────────────────────────────────────────────

// The ProjectPath shape `refreshSingleSpec` expects (code + name + cwd).
const FIXTURE_PROJECT = {
  code: PROJECT_CODE,
  name: PROJECT_CODE,
  cwd: PROJECT_CWD,
};

beforeAll(() => {
  // Seed fs.
  mkdirSync(SPEC_PROGRESS_DIR, { recursive: true });
  mkdirSync(SPEC_ARCHIVE_DIR, { recursive: true });
  writeFileSync(join(SPEC_PROGRESS_DIR, "proposal.md"), "# proposal\n");
  writeFileSync(
    SPEC_PROGRESS_TASKS,
    tasksMarkdown(progressState.completed, progressState.total),
  );
  writeFileSync(join(SPEC_ARCHIVE_DIR, "proposal.md"), "# proposal\n");
  writeFileSync(join(SPEC_ARCHIVE_DIR, "tasks.md"), tasksMarkdown(0, 3));

  // Seed in-memory project state so `processProjectSpecs` (and the refresh
  // diff it drives) has a baseline. Mirrors what the first poll tick does.
  _projectState.clear();
  processProjectSpecs(
    PROJECT_CODE,
    PROJECT_CWD,
    [
      {
        name: SPEC_PROGRESS,
        status: "active",
        completedTasks: progressState.completed,
        totalTasks: progressState.total,
      },
      {
        name: SPEC_ARCHIVE,
        status: "active",
        completedTasks: 0,
        totalTasks: 3,
      },
    ],
    /* firstTick */ true,
  );
});

afterAll(() => {
  __resetGetProjectsForTesting();
  try {
    rmSync(BASE, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Subscribe to SpecTransition events on the bus, filter by project, and
 * resolve when one matches the predicate OR timeout.
 */
function waitForTransition(
  predicate: (env: LifecycleEnvelope<"SpecTransition">) => boolean,
  timeoutMs: number,
): Promise<LifecycleEnvelope<"SpecTransition"> | null> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      lifecycleBus.off("SpecTransition", handler);
      resolve(null);
    }, timeoutMs);

    const handler = (env: LifecycleEnvelope<"SpecTransition">) => {
      if (env.payload.project !== PROJECT_CODE) return;
      if (!predicate(env)) return;
      clearTimeout(timeout);
      lifecycleBus.off("SpecTransition", handler);
      resolve(env);
    };
    lifecycleBus.on("SpecTransition", handler);
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("spec-watcher targeted-refresh → lifecycleBus", () => {
  test(
    "[SpecB 5.2] tasks.md checkbox count change emits a progress transition",
    async () => {
      // Subscribe BEFORE triggering so we never miss the synchronous emit.
      // The deadline here is a safety net only — the refresh below emits the
      // transition before `await refreshSingleSpec(...)` resolves, so the
      // promise is settled by the time we await it. No fs.watch race.
      const received = waitForTransition(
        (env) =>
          env.payload.specName === SPEC_PROGRESS &&
          env.payload.transition === "progress",
        5_000,
      );

      // Simulate ticking checkboxes in tasks.md: 2/5 -> 4/5. Write to disk
      // (so the on-disk fixture stays consistent) and update the mock state
      // so the mocked `openspec show <spec> --json` reports the new count.
      progressState.completed = 4;
      writeFileSync(
        SPEC_PROGRESS_TASKS,
        tasksMarkdown(progressState.completed, progressState.total),
      );

      // Drive the watcher's targeted refresh DIRECTLY — this is the exact
      // function the debounced fs.watch callback calls. It runs the mocked
      // `openspec show`, diffs against seeded state, and emits the progress
      // transition on the bus. Deterministic: emission completes before the
      // await resolves.
      await refreshSingleSpec(FIXTURE_PROJECT, SPEC_PROGRESS);

      const env = await received;

      expect(env).not.toBeNull();
      expect(env!.payload.transition).toBe("progress");
      expect(env!.payload.specName).toBe(SPEC_PROGRESS);
      if (env!.payload.transition === "progress") {
        expect(env!.payload.completed).toBe(4);
        expect(env!.payload.total).toBe(5);
      }
    },
    { timeout: 10_000 },
  );

  test(
    "[SpecB 5.3] removing a spec directory emits an archived (removed) transition",
    async () => {
      const received = waitForTransition(
        (env) =>
          env.payload.specName === SPEC_ARCHIVE &&
          env.payload.transition === "removed",
        5_000,
      );

      // Simulate `openspec archive` rename: drop the change dir entirely and
      // advance the mock so `openspec show` returns [] (empty), which routes
      // the refresh through `handleEmptySnapshots` -> full pollProjectSpecs ->
      // observes the dir is gone -> emits `removed`.
      archiveState.exists = false;
      rmSync(SPEC_ARCHIVE_DIR, { recursive: true, force: true });

      // Drive the refresh directly (same determinism as 5.2). The empty-show
      // branch falls back to a real pollProjectSpecs over the temp tree, which
      // no longer contains SPEC_ARCHIVE, so processProjectSpecs emits `removed`.
      await refreshSingleSpec(FIXTURE_PROJECT, SPEC_ARCHIVE);

      const env = await received;
      expect(env).not.toBeNull();
      expect(env!.payload.transition).toBe("removed");
      expect(env!.payload.specName).toBe(SPEC_ARCHIVE);
    },
    { timeout: 10_000 },
  );
});
