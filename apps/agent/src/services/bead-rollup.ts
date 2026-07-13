/**
 * Per-proposal bead rollup — the shared primitive behind the specs,
 * roadmap, and unlinked-beads surfaces (add-bead-proposal-roadmap-surface).
 *
 * The proposal -> bead link is already materialised by `spec-sync` as three
 * marker forms in every proposal's `tasks.md`:
 *
 *   <!-- beads:epic:<id> -->        capability epic (whole-file, top)
 *   <!-- beads:feature:<id> -->     this proposal's feature bead (top)
 *   - [x] 1.1 ... [beads:<id>]      per task line
 *
 * We parse those markers, then resolve live state with a SINGLE batched
 * `bd list --id <csv> --json` — no per-bead N+1, no dependence on the
 * missing bulk `spec_id` filter.
 *
 * Every bd interaction is degradable: on any failure the rollup is `null`
 * (never thrown), mirroring `fetchBeadsSummary` in `routes/specs.ts`.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "@nexus/core/node";
import type { BeadRef, BeadRollup, UnlinkedBead } from "@nexus/core";
import { execJson } from "../utils/exec";

const log = createLogger("agent:services:bead-rollup");

// ---------------------------------------------------------------------------
// Raw bd JSON shape (the subset we read)
// ---------------------------------------------------------------------------

export interface RawBead {
  id: string;
  title?: string;
  status?: string;
  issue_type?: string;
  priority?: number;
  spec_id?: string;
  parent?: string;
  dependencies?: Array<{
    depends_on_id?: string;
    type?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Bead source (DI seam — tests inject a fake, production uses `bd`)
// ---------------------------------------------------------------------------

export interface RollupBeadSource {
  /** Batch-fetch beads by id (`bd list --id <csv> --json`). */
  listBeads(ids: string[], cwd: string): Promise<RawBead[]>;
}

export const defaultRollupBeadSource: RollupBeadSource = {
  async listBeads(ids, cwd) {
    if (ids.length === 0) return [];
    // `--all` is MANDATORY: without it `bd list --id` excludes closed beads,
    // so every rollup's `closed` count is 0 and `total` is undercounted
    // (only open task beads come back). The progress bar is closed/total, so
    // omitting `--all` silently breaks the whole feature.
    return execJson<RawBead[]>(
      "bd",
      ["list", "--id", ids.join(","), "--all", "--json"],
      { cwd },
    );
  },
};

// ---------------------------------------------------------------------------
// Marker parsing (pure)
// ---------------------------------------------------------------------------

export interface BeadMarkers {
  epicId: string | null;
  featureId: string | null;
  taskIds: string[];
}

const EPIC_RE = /<!--\s*beads:epic:([A-Za-z0-9-]+)\s*-->/;
const FEATURE_RE = /<!--\s*beads:feature:([A-Za-z0-9-]+)\s*-->/;
// Per-task marker: `[beads:<id>]`. Global — one per task line.
const TASK_RE = /\[beads:([A-Za-z0-9-]+)\]/g;

/**
 * Extract the epic / feature / task bead ids from a `tasks.md` body.
 * Task ids are de-duplicated in first-seen order. Missing markers yield
 * `null` (epic/feature) or `[]` (tasks).
 */
export function parseBeadMarkers(tasksMd: string): BeadMarkers {
  const epicId = EPIC_RE.exec(tasksMd)?.[1] ?? null;
  const featureId = FEATURE_RE.exec(tasksMd)?.[1] ?? null;

  const seen = new Set<string>();
  const taskIds: string[] = [];
  for (const m of tasksMd.matchAll(TASK_RE)) {
    const id = m[1]!;
    if (seen.has(id)) continue;
    seen.add(id);
    taskIds.push(id);
  }

  return { epicId, featureId, taskIds };
}

// ---------------------------------------------------------------------------
// Blocked derivation (pure)
// ---------------------------------------------------------------------------

/**
 * Derive the set of bead ids that are blocked.
 *
 * A bead is blocked when its status is `blocked`, OR it has a `blocks`
 * dependency edge (`bd dep add <blocked> <blocker>`) whose blocker is not
 * closed. Blocker status is resolved from `beads`; a blocker absent from
 * the set is treated as unclosed (we cannot prove it closed), matching the
 * "unclosed blocks dependency" contract.
 *
 * Pure — mirrors beadboard's `deriveBlockedIds`.
 */
export function deriveBlockedIds(beads: RawBead[]): Set<string> {
  const statusById = new Map<string, string>();
  for (const b of beads) statusById.set(b.id, b.status ?? "");

  const blocked = new Set<string>();
  for (const b of beads) {
    if (b.status === "blocked") {
      blocked.add(b.id);
      continue;
    }
    for (const dep of b.dependencies ?? []) {
      if (dep.type !== "blocks") continue;
      const blockerId = dep.depends_on_id;
      if (!blockerId) continue;
      const blockerStatus = statusById.get(blockerId);
      // Absent blocker → unknown → treat as not-closed → blocking.
      if (blockerStatus !== "closed") {
        blocked.add(b.id);
        break;
      }
    }
  }
  return blocked;
}

// ---------------------------------------------------------------------------
// Aggregation (pure)
// ---------------------------------------------------------------------------

function toBeadRef(b: RawBead): BeadRef {
  return {
    id: b.id,
    status: b.status ?? "unknown",
    type: b.issue_type ?? "unknown",
    priority: typeof b.priority === "number" ? b.priority : 0,
    title: b.title ?? "",
  };
}

/** A zeroed rollup — used for empty-marker proposals and null coercion. */
export function emptyRollup(): BeadRollup {
  return {
    epic: null,
    feature: null,
    tasks: { total: 0, closed: 0, ready: 0, blocked: 0 },
    beads: [],
  };
}

/**
 * Fold parsed markers + resolved beads into a {@link BeadRollup}. Task counts
 * consider ONLY the beads whose ids appear in `markers.taskIds` AND that `bd`
 * actually returned, so a deleted / renamed task bead simply drops out
 * (never inflates `total`).
 *
 * `ready` is derived purely from `beads` (mirrors beads-watcher's
 * `deriveUnlinkedCounts`): a task bead is ready when it is not closed and not
 * blocked (per `deriveBlockedIds`). This is a BEHAVIOR CHANGE vs the old
 * `bd ready` CLI semantics — `bd ready` also excludes `in_progress` beads,
 * so an in_progress-but-unblocked task now counts as ready where it
 * previously did not. No separate `bd ready` call is issued.
 *
 * Pure — no IO.
 */
export function aggregateRollup(markers: BeadMarkers, beads: RawBead[]): BeadRollup {
  const byId = new Map<string, RawBead>();
  for (const b of beads) byId.set(b.id, b);

  const blockedIds = deriveBlockedIds(beads);

  const taskBeads: RawBead[] = [];
  for (const id of markers.taskIds) {
    const b = byId.get(id);
    if (b) taskBeads.push(b);
  }

  let closed = 0;
  let ready = 0;
  let blocked = 0;
  for (const b of taskBeads) {
    if (b.status === "closed") closed++;
    if (b.status !== "closed" && !blockedIds.has(b.id)) ready++;
    if (blockedIds.has(b.id)) blocked++;
  }

  const epicBead = markers.epicId ? byId.get(markers.epicId) : undefined;
  const featureBead = markers.featureId ? byId.get(markers.featureId) : undefined;

  return {
    epic: epicBead ? toBeadRef(epicBead) : null,
    feature: featureBead ? toBeadRef(featureBead) : null,
    tasks: { total: taskBeads.length, closed, ready, blocked },
    beads: beads.map(toBeadRef),
  };
}

/**
 * Filter open/in_progress beads down to those NOT linked by any live
 * proposal, mapping to the {@link UnlinkedBead} wire shape. Pure.
 */
export function filterUnlinked(
  open: RawBead[],
  linked: Set<string>,
): UnlinkedBead[] {
  const out: UnlinkedBead[] = [];
  for (const b of open) {
    if (linked.has(b.id)) continue;
    out.push({
      id: b.id,
      title: b.title ?? "",
      status: b.status ?? "unknown",
      priority: typeof b.priority === "number" ? b.priority : 0,
      type: b.issue_type ?? "unknown",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// tasks.md resolution (live -> archive), mirrors readProposalFrontmatter
// ---------------------------------------------------------------------------

/**
 * Resolve a proposal's `tasks.md` body, trying the live change dir first
 * then the archive (mirrors `readProposalFrontmatter`'s lookup order in
 * routes/specs.ts). Returns `null` when neither exists.
 */
export function resolveTasksMd(
  projectPath: string,
  specName: string,
): string | null {
  const livePath = join(
    projectPath,
    "openspec",
    "changes",
    specName,
    "tasks.md",
  );
  if (existsSync(livePath)) {
    try {
      return readFileSync(livePath, "utf8");
    } catch {
      /* fall through to archive */
    }
  }

  const archiveRoot = join(projectPath, "openspec", "changes", "archive");
  if (existsSync(archiveRoot)) {
    try {
      const suffix = `-${specName}`;
      for (const entry of readdirSync(archiveRoot)) {
        if (entry === specName || entry.endsWith(suffix)) {
          const candidate = join(archiveRoot, entry, "tasks.md");
          if (existsSync(candidate)) {
            try {
              return readFileSync(candidate, "utf8");
            } catch {
              /* keep searching */
            }
          }
        }
      }
    } catch {
      /* fall through */
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Linked-id collection across live proposals
// ---------------------------------------------------------------------------

/**
 * Union of every marker-linked bead id (epic + feature + tasks) across all
 * LIVE proposals under `openspec/changes/` (the `archive/` sibling is NOT
 * scanned — a bead whose only proposal was archived legitimately resurfaces
 * as unlinked open work).
 */
export async function collectLinkedBeadIds(
  projectPath: string,
): Promise<Set<string>> {
  const linked = new Set<string>();
  const changesRoot = join(projectPath, "openspec", "changes");
  if (!existsSync(changesRoot)) return linked;

  let entries: string[];
  try {
    entries = await readdir(changesRoot);
  } catch {
    return linked;
  }

  for (const entry of entries) {
    if (entry === "archive" || entry.startsWith(".")) continue;
    const tasksPath = join(changesRoot, entry, "tasks.md");
    if (!existsSync(tasksPath)) continue;
    let body: string;
    try {
      body = await readFile(tasksPath, "utf8");
    } catch {
      continue;
    }
    const { epicId, featureId, taskIds } = parseBeadMarkers(body);
    if (epicId) linked.add(epicId);
    if (featureId) linked.add(featureId);
    for (const id of taskIds) linked.add(id);
  }

  return linked;
}

// ---------------------------------------------------------------------------
// computeBeadRollup — IO orchestrator
// ---------------------------------------------------------------------------

/**
 * Compute the live {@link BeadRollup} for a single proposal.
 *
 * Returns `null` when the project has no `.beads/` directory, has no
 * resolvable `tasks.md`, or `bd` errors — the caller keeps its payload
 * otherwise unchanged (never a 500). An empty-marker `tasks.md` yields a
 * zeroed rollup (not `null`) since `bd` was reachable.
 */
export async function computeBeadRollup(
  projectPath: string,
  specName: string,
  source: RollupBeadSource = defaultRollupBeadSource,
): Promise<BeadRollup | null> {
  if (!existsSync(join(projectPath, ".beads"))) return null;

  const tasksMd = resolveTasksMd(projectPath, specName);
  if (tasksMd === null) return null;

  const markers = parseBeadMarkers(tasksMd);
  const ids = [markers.epicId, markers.featureId, ...markers.taskIds].filter(
    (x): x is string => Boolean(x),
  );

  try {
    const beads = await source.listBeads(ids, projectPath);
    return aggregateRollup(markers, Array.isArray(beads) ? beads : []);
  } catch (err) {
    // Previously a silent `catch { return null }` — the swallow is WHY this
    // failure mode (bd timeout under per-spec fan-out) was invisible in the
    // journal. Log it so a degraded rollup is diagnosable.
    log.warn({ err, specName }, "bead rollup compute failed");
    return null;
  }
}

// ---------------------------------------------------------------------------
// computeRollupsForProject — batched IO orchestrator (one bd call per PROJECT)
// ---------------------------------------------------------------------------

/**
 * Compute rollups for MANY proposals with exactly ONE `bd list` for the
 * whole project — the fix for the unbounded per-spec `bd` fan-out that
 * saturated the box and tripped the 10s exec timeout on large projects
 * (every project after the first returned null rollups). There is no
 * `bd ready` call at all: "ready" is derived purely from the fetched bead
 * set (see {@link aggregateRollup}), which also fixes a latent undercounting
 * bug — the old `bd ready` call carried no `--limit`, so it silently
 * inherited the bd CLI's default `--limit 10` and truncated the ready set
 * for any project/spec with more than 10 ready tasks.
 *
 * `bd`/dolt is a 137MB binary (~1.2s cold); a 38-spec project spawning ~38
 * concurrent `bd` is the root cause. Bounding concurrency did not help — the
 * only fix is one spawn per project, not per spec.
 *
 * Contract (matches {@link computeBeadRollup} per spec):
 *   - No `.beads/` dir            -> every spec maps to `null`.
 *   - `tasks.md` unresolvable     -> that spec maps to `null`.
 *   - Reachable but marker-less   -> that spec maps to a zeroed rollup.
 *   - bd failure                  -> every marker-parsed spec degrades to
 *                                    `null` (never throws; logs a warn).
 *   - Empty id union              -> no bd spawn at all.
 *
 * Each spec's rollup is folded from the SHARED bead map but partitioned down
 * to that spec's own linked ids first, so `rollup.beads` (the detail-view
 * set) never leaks another spec's beads.
 */
export async function computeRollupsForProject(
  projectPath: string,
  specNames: string[],
  source: RollupBeadSource = defaultRollupBeadSource,
): Promise<Map<string, BeadRollup | null>> {
  const out = new Map<string, BeadRollup | null>();

  // No `.beads/` -> every spec null (mirrors computeBeadRollup's guard).
  if (!existsSync(join(projectPath, ".beads"))) {
    for (const name of specNames) out.set(name, null);
    return out;
  }

  // 1. Parse markers per spec; a spec with no resolvable tasks.md maps to
  //    null now and never enters the bd union.
  const markersBySpec = new Map<string, BeadMarkers>();
  const unionIds = new Set<string>();
  for (const name of specNames) {
    const tasksMd = resolveTasksMd(projectPath, name);
    if (tasksMd === null) {
      out.set(name, null);
      continue;
    }
    const markers = parseBeadMarkers(tasksMd);
    markersBySpec.set(name, markers);
    if (markers.epicId) unionIds.add(markers.epicId);
    if (markers.featureId) unionIds.add(markers.featureId);
    for (const id of markers.taskIds) unionIds.add(id);
  }

  // 2. Empty union -> nothing to fetch. Every marker-parsed spec folds to a
  //    zeroed rollup (no bd spawn — the empty-marker case is bd-independent).
  if (unionIds.size === 0) {
    for (const [name, markers] of markersBySpec) {
      out.set(name, aggregateRollup(markers, []));
    }
    return out;
  }

  // 3. ONE `bd list --id <union> --all` for the whole project — the whole
  //    point of this function. No `bd ready` call — ready is derived from
  //    the fetched beads (see aggregateRollup).
  let byId: Map<string, RawBead>;
  try {
    const beads = await source.listBeads([...unionIds], projectPath);
    byId = new Map(
      (Array.isArray(beads) ? beads : []).map((b) => [b.id, b] as const),
    );
  } catch (err) {
    log.warn(
      { err, projectPath, specCount: markersBySpec.size },
      "bead rollup batch compute failed",
    );
    for (const name of markersBySpec.keys()) out.set(name, null);
    return out;
  }

  // 4. Fold each spec from the SHARED maps, partitioned to its own ids so the
  //    detail-view `beads` set is not polluted by sibling specs.
  for (const [name, markers] of markersBySpec) {
    const ids = [markers.epicId, markers.featureId, ...markers.taskIds].filter(
      (x): x is string => Boolean(x),
    );
    const specBeads: RawBead[] = [];
    for (const id of ids) {
      const b = byId.get(id);
      if (b) specBeads.push(b);
    }
    out.set(name, aggregateRollup(markers, specBeads));
  }

  return out;
}
