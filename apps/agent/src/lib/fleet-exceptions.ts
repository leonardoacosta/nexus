/**
 * Fleet exceptions computation (add-fleet-exceptions-feed).
 *
 * Walks every `~/dev/<repo>/.beads` store, reads via {@link readBeadsStore},
 * and classifies each repo into a small set of EXCEPTION classes — the
 * signal, never the browsable item list. A clean repo produces zero entries;
 * a clean fleet produces an empty array. Missing / corrupt stores are
 * recorded as `skipped` (never thrown).
 *
 * Doctrine (proposal): render shape and exceptions, silent when clean. Each
 * per-repo/per-class entry carries a count + up to {@link OFFENDER_CAP}
 * worst-offender ids — text for use in a terminal, not a drill-in list.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@nexus/core/node";
import { readBeadsStore, type BeadRow } from "./beads-reader";

const log = createLogger("agent:lib:fleet-exceptions");

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

export const IN_PROGRESS_STALE_DAYS = 7;
export const READY_HEAD_STALE_DAYS = 30;
/** Max offender ids carried per payload entry (proposal: capped, never a list). */
export const OFFENDER_CAP = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

export type FleetExceptionClass =
  | "p0_open"
  | "p1_open"
  | "in_progress_stale"
  | "ready_head_stale"
  | "unarchived_changes";

/** One (repo, class) exception line. `offenders` is capped at {@link OFFENDER_CAP}. */
export interface FleetExceptionEntry {
  /** Project directory name under `~/dev` (e.g. "nx"). */
  repo: string;
  class: FleetExceptionClass;
  /** Total count in this class (may exceed `offenders.length`). */
  count: number;
  /** Worst-first, capped: bead ids (or proposal slugs for unarchived_changes). */
  offenders: string[];
}

export interface FleetSkip {
  repo: string;
  reason: "missing_store" | "corrupt_store";
}

export interface FleetExceptionsResult {
  exceptions: FleetExceptionEntry[];
  skipped: FleetSkip[];
}

// ---------------------------------------------------------------------------
// Options (DI seams — tests inject devRoot / now / reader / changes counter)
// ---------------------------------------------------------------------------

export interface ComputeFleetExceptionsOptions {
  /** Fleet root to walk. Default `~/dev`. */
  devRoot?: string;
  /** Clock. Default `() => Date.now()`. */
  now?: () => number;
  /** Store reader. Default {@link readBeadsStore}. */
  readStore?: (beadsDir: string) => Promise<BeadRow[] | null>;
  /**
   * Unarchived openspec/changes counter for a repo path. Default reads
   * `<repoPath>/openspec/changes/` from disk.
   */
  countChanges?: (repoPath: string) => { count: number; slugs: string[] };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const OPEN_STATUSES = new Set(["open", "in_progress"]);

function ageMs(now: number, iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return now - t;
}

/** Sort ids by descending age (oldest / most-festering first), then id. */
function worstFirst(
  rows: BeadRow[],
  now: number,
  pick: (r: BeadRow) => string | null,
): string[] {
  return rows
    .map((r) => ({ id: r.id, age: ageMs(now, pick(r)) ?? -Infinity }))
    .sort((a, b) => b.age - a.age || a.id.localeCompare(b.id))
    .map((x) => x.id);
}

function entry(
  repo: string,
  cls: FleetExceptionClass,
  ids: string[],
): FleetExceptionEntry | null {
  if (ids.length === 0) return null;
  return { repo, class: cls, count: ids.length, offenders: ids.slice(0, OFFENDER_CAP) };
}

/**
 * Classify a single repo's beads (+ its unarchived-changes signal) into
 * exception entries. Pure — no IO. Returns only non-empty classes.
 */
export function classifyRepo(
  repo: string,
  rows: BeadRow[],
  changes: { count: number; slugs: string[] },
  now: number,
): FleetExceptionEntry[] {
  const out: FleetExceptionEntry[] = [];

  const openBeads = rows.filter((r) => OPEN_STATUSES.has(r.status));

  // P0 / P1 open — worst-first by oldest createdAt (longest unresolved).
  const p0 = openBeads.filter((r) => r.priority === 0);
  const p1 = openBeads.filter((r) => r.priority === 1);
  const p0Entry = entry(repo, "p0_open", worstFirst(p0, now, (r) => r.createdAt));
  if (p0Entry) out.push(p0Entry);
  const p1Entry = entry(repo, "p1_open", worstFirst(p1, now, (r) => r.createdAt));
  if (p1Entry) out.push(p1Entry);

  // in_progress claims stale > 7 days — age from startedAt, else updatedAt.
  const stale = rows.filter((r) => {
    if (r.status !== "in_progress") return false;
    const a = ageMs(now, r.startedAt) ?? ageMs(now, r.updatedAt);
    return a !== null && a > IN_PROGRESS_STALE_DAYS * DAY_MS;
  });
  const staleEntry = entry(
    repo,
    "in_progress_stale",
    worstFirst(stale, now, (r) => r.startedAt ?? r.updatedAt),
  );
  if (staleEntry) out.push(staleEntry);

  // ready-head older than 30 days — "ready" = open + no blockers
  // (dependencyCount === 0). Flags every ready bead festering past the
  // threshold; the head (worst) is offender #1.
  const readyStale = rows.filter((r) => {
    if (r.status !== "open" || r.dependencyCount !== 0) return false;
    const a = ageMs(now, r.createdAt);
    return a !== null && a > READY_HEAD_STALE_DAYS * DAY_MS;
  });
  const readyEntry = entry(
    repo,
    "ready_head_stale",
    worstFirst(readyStale, now, (r) => r.createdAt),
  );
  if (readyEntry) out.push(readyEntry);

  // Unarchived openspec/changes signal — offenders are slug names.
  if (changes.count > 0) {
    out.push({
      repo,
      class: "unarchived_changes",
      count: changes.count,
      offenders: [...changes.slugs].sort().slice(0, OFFENDER_CAP),
    });
  }

  return out;
}

/**
 * Count live (unarchived) `openspec/changes/<slug>` dirs for a repo, ignoring
 * the `archive/` sibling and dotfiles. Never throws.
 */
export function countUnarchivedChanges(repoPath: string): {
  count: number;
  slugs: string[];
} {
  const changesRoot = join(repoPath, "openspec", "changes");
  if (!existsSync(changesRoot)) return { count: 0, slugs: [] };

  let entries: string[];
  try {
    entries = readdirSync(changesRoot);
  } catch {
    return { count: 0, slugs: [] };
  }

  const slugs: string[] = [];
  for (const name of entries) {
    if (name === "archive" || name.startsWith(".")) continue;
    try {
      if (statSync(join(changesRoot, name)).isDirectory()) slugs.push(name);
    } catch {
      /* skip unstatable entry */
    }
  }
  return { count: slugs.length, slugs };
}

// ---------------------------------------------------------------------------
// computeFleetExceptions — IO orchestrator
// ---------------------------------------------------------------------------

/**
 * Walk `~/dev/*` (or an injected root), read each repo's `.beads/` store, and
 * classify into exception entries. Never throws — a store that fails to read
 * is recorded in `skipped`, and any unexpected error degrades to an empty
 * result.
 */
export async function computeFleetExceptions(
  opts: ComputeFleetExceptionsOptions = {},
): Promise<FleetExceptionsResult> {
  const devRoot = opts.devRoot ?? join(homedir(), "dev");
  const now = (opts.now ?? Date.now)();
  const readStore = opts.readStore ?? readBeadsStore;
  const countChanges = opts.countChanges ?? countUnarchivedChanges;

  const exceptions: FleetExceptionEntry[] = [];
  const skipped: FleetSkip[] = [];

  let repos: string[];
  try {
    repos = readdirSync(devRoot);
  } catch (err) {
    log.warn({ err, devRoot }, "cannot read fleet root; empty result");
    return { exceptions, skipped };
  }

  for (const repo of repos) {
    if (repo.startsWith(".")) continue;
    const repoPath = join(devRoot, repo);
    const beadsDir = join(repoPath, ".beads");

    // Only repos that HAVE a .beads store participate at all.
    let hasBeads: boolean;
    try {
      hasBeads = statSync(repoPath).isDirectory() && existsSync(beadsDir);
    } catch {
      continue;
    }
    if (!hasBeads) continue;

    let rows: BeadRow[] | null;
    try {
      rows = await readStore(beadsDir);
    } catch (err) {
      // readBeadsStore is contracted not to throw; defense in depth.
      log.warn({ err, repo }, "store read threw; skipping");
      skipped.push({ repo, reason: "corrupt_store" });
      continue;
    }

    if (rows === null) {
      const hasJsonl = existsSync(join(beadsDir, "issues.jsonl"));
      skipped.push({ repo, reason: hasJsonl ? "corrupt_store" : "missing_store" });
      continue;
    }

    let changes: { count: number; slugs: string[] };
    try {
      changes = countChanges(repoPath);
    } catch {
      changes = { count: 0, slugs: [] };
    }

    exceptions.push(...classifyRepo(repo, rows, changes, now));
  }

  return { exceptions, skipped };
}
