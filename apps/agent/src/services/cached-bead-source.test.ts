/**
 * cached-bead-source tests (nx-veo5g.1 — Layer A of the crash-loop fix).
 *
 * Proves the request-path bead source reads from the beads-watcher's in-memory
 * parsed cache with ZERO subprocess on a warm cache, and falls back to exactly
 * ONE `bd list --all` on a cold-start miss (single-flight coalesced), degrading
 * to `[]` on failure.
 *
 * `execJson` is spied via the restorable `spyOn(exec, …)` pattern (nx-509z5
 * class — never `mock.module`, which leaks process-globally). The watcher cache
 * is populated through the REAL `readParsedBeads` against a tmpdir fixture, so
 * the cache-hit path exercises the true code path, not a stub.
 */

import { describe, test, expect, spyOn, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as exec from "../utils/exec";
import { readParsedBeads } from "./beads-watcher";
import type { RawBead } from "./bead-rollup";
import {
  getBeadsForProject,
  cachedRollupBeadSource,
  cachedRoadmapBeadSource,
  cachedUnlinkedBeadSource,
} from "./cached-bead-source";

const tempDirs: string[] = [];

afterEach(() => {
  spyOn(exec, "execJson").mockRestore();
  while (tempDirs.length) {
    try {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Write a `.beads/issues.jsonl` full-dump under a fresh tmp project + warm the cache. */
async function warmProject(beads: RawBead[]): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "nx-cbs-"));
  tempDirs.push(root);
  mkdirSync(join(root, ".beads"), { recursive: true });
  writeFileSync(
    join(root, ".beads", "issues.jsonl"),
    beads.map((b) => JSON.stringify(b)).join("\n") + "\n",
  );
  // Populate the module-level parsed-bead cache via the real read path.
  const parsed = await readParsedBeads(root);
  expect(parsed).not.toBeNull();
  return root;
}

/** A cold tmp path the watcher has never parsed (cache miss). */
function coldPath(): string {
  const root = mkdtempSync(join(tmpdir(), "nx-cbs-cold-"));
  tempDirs.push(root);
  return root;
}

describe("getBeadsForProject — cache hit (warm)", () => {
  test("returns cached beads WITHOUT spawning a subprocess", async () => {
    const beads: RawBead[] = [
      { id: "nx-1", status: "open", issue_type: "task" },
      { id: "nx-2", status: "closed", issue_type: "feature" },
    ];
    const root = await warmProject(beads);

    const spy = spyOn(exec, "execJson").mockResolvedValue([] as RawBead[]);
    const got = await getBeadsForProject(root);

    expect(got.map((b) => b.id).sort()).toEqual(["nx-1", "nx-2"]);
    // The whole point: a warm cache never shells out to `bd`.
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("getBeadsForProject — cold start (cache miss)", () => {
  test("falls back to exactly ONE `bd list --all --json`", async () => {
    const fixture: RawBead[] = [{ id: "nx-cold-1", status: "open", issue_type: "task" }];
    const spy = spyOn(exec, "execJson").mockResolvedValue(fixture as RawBead[]);

    const got = await getBeadsForProject(coldPath());

    expect(got).toEqual(fixture);
    expect(spy).toHaveBeenCalledTimes(1);
    const [cmd, args] = spy.mock.calls[0]!;
    expect(cmd).toBe("bd");
    expect(args).toEqual(["list", "--all", "--json"]);
  });

  test("single-flight coalesces concurrent cold-start callers into ONE spawn", async () => {
    const fixture: RawBead[] = [{ id: "nx-sf-1", status: "open", issue_type: "task" }];
    // Delay so both callers register before the first spawn settles.
    const spy = spyOn(exec, "execJson").mockImplementation((async () => {
      await sleep(25);
      return fixture;
    }) as typeof exec.execJson);

    const path = coldPath();
    // Launch concurrently — do NOT await between them.
    const [a, b, c] = await Promise.all([
      getBeadsForProject(path),
      getBeadsForProject(path),
      getBeadsForProject(path),
    ]);

    expect(a).toEqual(fixture);
    expect(b).toEqual(fixture);
    expect(c).toEqual(fixture);
    // Three concurrent callers, ONE subprocess.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test("degrades to [] on live-call failure (never throws)", async () => {
    spyOn(exec, "execJson").mockRejectedValue(new Error("bd exploded"));
    const got = await getBeadsForProject(coldPath());
    expect(got).toEqual([]);
  });
});

describe("cachedRollupBeadSource", () => {
  test("listBeads filters the cached full set down to the requested ids", async () => {
    const root = await warmProject([
      { id: "nx-a", status: "open", issue_type: "task" },
      { id: "nx-b", status: "closed", issue_type: "task" },
      { id: "nx-c", status: "open", issue_type: "epic" },
    ]);
    const spy = spyOn(exec, "execJson").mockResolvedValue([] as RawBead[]);

    const got = await cachedRollupBeadSource.listBeads(["nx-a", "nx-c", "nx-missing"], root);

    expect(got.map((b) => b.id).sort()).toEqual(["nx-a", "nx-c"]);
    expect(spy).not.toHaveBeenCalled();
  });

  test("listBeads short-circuits to [] on empty ids (no cache read, no spawn)", async () => {
    const spy = spyOn(exec, "execJson").mockResolvedValue([] as RawBead[]);
    expect(await cachedRollupBeadSource.listBeads([], coldPath())).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("cachedRoadmapBeadSource", () => {
  test("listEpics/listAll/showSpecId all derive from the same cached set, no spawn", async () => {
    const root = await warmProject([
      { id: "nx-epic", status: "open", issue_type: "epic", title: "[CAPABILITY] X" },
      { id: "nx-feat", status: "open", issue_type: "feature", parent: "nx-epic", spec_id: "the-slug" },
      { id: "nx-task", status: "open", issue_type: "task", parent: "nx-feat" },
    ]);
    const spy = spyOn(exec, "execJson").mockResolvedValue([] as RawBead[]);

    const epics = await cachedRoadmapBeadSource.listEpics(root);
    expect(epics.map((b) => b.id)).toEqual(["nx-epic"]);

    const all = await cachedRoadmapBeadSource.listAll(root);
    expect(all.map((b) => b.id).sort()).toEqual(["nx-epic", "nx-feat", "nx-task"]);

    expect(await cachedRoadmapBeadSource.showSpecId("nx-feat", root)).toBe("the-slug");
    // A bead without spec_id resolves to null.
    expect(await cachedRoadmapBeadSource.showSpecId("nx-task", root)).toBeNull();
    // An absent id resolves to null.
    expect(await cachedRoadmapBeadSource.showSpecId("nx-nope", root)).toBeNull();

    expect(spy).not.toHaveBeenCalled();
  });
});

describe("parent reconstruction from parent-child dep (JSONL export gap)", () => {
  test("cached beads flatten parent from the parent-child dependency edge", async () => {
    // `bd export` omits the top-level `parent` field that `bd list --json`
    // carries — it lives ONLY in `dependencies`. The parse path reconstructs
    // it so roadmap's `b.parent === epic.id` child resolution works off cache.
    const root = await warmProject([
      { id: "nx-epic", status: "open", issue_type: "epic", title: "[CAPABILITY] Y" },
      {
        id: "nx-feat",
        status: "open",
        issue_type: "feature",
        spec_id: "feat-slug",
        // No top-level `parent` — only the dependency edge (export shape).
        dependencies: [{ depends_on_id: "nx-epic", type: "parent-child" }],
      },
    ]);
    const spy = spyOn(exec, "execJson").mockResolvedValue([] as RawBead[]);

    const all = await cachedRoadmapBeadSource.listAll(root);
    const feat = all.find((b) => b.id === "nx-feat");
    // Reconstructed: parent now points at the capability epic.
    expect(feat?.parent).toBe("nx-epic");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("cachedUnlinkedBeadSource", () => {
  test("listOpenBeads filters the cached full set to open/in_progress client-side", async () => {
    const root = await warmProject([
      { id: "nx-open", status: "open", issue_type: "task" },
      { id: "nx-prog", status: "in_progress", issue_type: "task" },
      { id: "nx-closed", status: "closed", issue_type: "task" },
      { id: "nx-blocked", status: "blocked", issue_type: "task" },
    ]);
    const spy = spyOn(exec, "execJson").mockResolvedValue([] as RawBead[]);

    const open = await cachedUnlinkedBeadSource.listOpenBeads(root);

    expect(open.map((b) => b.id).sort()).toEqual(["nx-open", "nx-prog"]);
    expect(spy).not.toHaveBeenCalled();
  });
});
