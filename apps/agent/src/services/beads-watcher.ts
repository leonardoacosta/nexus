/**
 * Beads filesystem watcher.
 *
 * `bd`'s `export.auto` rewrites `<project>/.beads/issues.jsonl` on every
 * mutation — a durable, local, no-cc-changes signal for bead state. This
 * watcher turns that file signal into per-project unlinked ready/blocked
 * recounts WITHOUT ever shelling out to `bd` (zero CLI calls on the hot
 * path — the agent's systemd sandbox breaks `bd`/`openspec` shell-outs in
 * prod, and `bd list` costs ~2s/invocation).
 *
 * Watch shape (nx-6uzqi, mirrors `credentials/active-credential-watcher.ts`):
 *   - Watch the PARENT dir (`.beads/`), filtered to `issues.jsonl`. Auto-export
 *     renames a temp file over the target, which invalidates a single-file
 *     inotify watch; a directory watch survives the inode churn.
 *   - 300ms debounce — one rewrite fans out to several fs events.
 *   - Unconditional 60s poll fallback — fs events are an optimization, never
 *     the only path (survives ENOSPC watch exhaustion / missed events).
 *   - AbortController teardown for every watch + poll timer.
 *
 * Fail-open (mirrors `config-watcher`): any read/parse error keeps the last
 * good in-memory counts and skips the recount callback — never crashes,
 * never zeroes out a project on a truncated mid-write read.
 *
 * Derivation reuses `services/bead-rollup.ts` (`deriveBlockedIds`,
 * `filterUnlinked`, `collectLinkedBeadIds`) so there is ONE definition of
 * "blocked" and "linked" shared with the live `beads-unlinked` route — the
 * spec's derivation-parity requirement.
 *
 * Spec: openspec/changes/add-project-status-snapshots/ (spec-watcher delta,
 * ADDED — beads filesystem watching).
 */

import { existsSync, readFileSync } from "node:fs";
import { stat, watch } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "@nexus/core/node";
import type { BeadUnlinkedCounts } from "@nexus/core";
import type { Db } from "@nexus/db";
import {
  collectLinkedBeadIds,
  deriveBlockedIds,
  filterUnlinked,
  type RawBead,
} from "./bead-rollup";
import { recordProjectStatusFromBeads } from "./status-snapshots";

const log = createLogger("agent:services:beads-watcher");

const DEBOUNCE_MS = 300;
const POLL_INTERVAL_MS = 60_000;
const ISSUES_FILE = "issues.jsonl";

// ---------------------------------------------------------------------------
// Parsing (pure, fail-open)
// ---------------------------------------------------------------------------

/**
 * Parse `.beads/issues.jsonl` content into {@link RawBead}s.
 *
 * `issues.jsonl` is a full-dump export with NON-deterministic row order, so
 * the parser must not assume order. Blank lines are skipped. On ANY malformed
 * line (a truncated mid-write, a partial JSON object) the WHOLE read is
 * treated as failed — returns `null` so the caller keeps its previous counts
 * rather than acting on a structurally-incomplete snapshot.
 */
export function parseIssuesJsonl(content: string): RawBead[] | null {
  const beads: RawBead[] = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      return null; // fail-open: any bad line invalidates this read
    }
    if (
      obj !== null &&
      typeof obj === "object" &&
      typeof (obj as RawBead).id === "string"
    ) {
      beads.push(obj as RawBead);
    }
  }
  return beads;
}

// ---------------------------------------------------------------------------
// Derivation (pure) — reuses bead-rollup so linkage/blocked semantics never fork
// ---------------------------------------------------------------------------

/**
 * Derive unlinked ready/blocked counts from a parsed bead set + the linked-id
 * set for a project.
 *
 * Open work = any bead not `closed` (open / in_progress / blocked). Among the
 * UNLINKED subset (not referenced by any live proposal's markers):
 *   - blocked = explicit `blocked` status OR an open `blocks` dependency
 *     (`deriveBlockedIds`, shared with bead-rollup).
 *   - ready   = the remaining open-and-unblocked beads.
 *
 * Pure — no IO.
 */
export function deriveUnlinkedCounts(
  beads: RawBead[],
  linked: Set<string>,
): BeadUnlinkedCounts {
  const open = beads.filter((b) => b.status !== "closed");
  const blockedIds = deriveBlockedIds(open);
  const unlinked = filterUnlinked(open, linked);

  let ready = 0;
  let blocked = 0;
  for (const b of unlinked) {
    if (blockedIds.has(b.id)) blocked++;
    else ready++;
  }
  return { beadsReadyUnlinked: ready, beadsBlockedUnlinked: blocked };
}

/**
 * Read + recount a single project's `.beads/issues.jsonl` from disk.
 *
 * Returns `null` (fail-open, caller keeps previous counts) when:
 *   - the project has no `.beads/issues.jsonl`,
 *   - the file cannot be read, or
 *   - the JSONL fails to parse (malformed / truncated mid-write).
 *
 * Zero `bd` CLI calls — parses the export file directly.
 */
export function computeBeadCountsFromDisk(
  projectPath: string,
): BeadUnlinkedCounts | null {
  const jsonlPath = join(projectPath, ".beads", ISSUES_FILE);
  if (!existsSync(jsonlPath)) return null;

  let content: string;
  try {
    content = readFileSync(jsonlPath, "utf8");
  } catch (err) {
    log.warn({ projectPath, err }, "beads-watcher: read failed; keeping counts");
    return null;
  }

  const beads = parseIssuesJsonl(content);
  if (beads === null) {
    log.warn(
      { projectPath },
      "beads-watcher: malformed issues.jsonl; keeping counts",
    );
    return null;
  }

  const linked = collectLinkedBeadIds(projectPath);
  return deriveUnlinkedCounts(beads, linked);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export interface BeadsWatcherProject {
  /** Stable project key — the `project` column in project_status_snapshots. */
  code: string;
  /** Absolute project path (contains `.beads/`). */
  path: string;
}

export interface BeadsWatcherDeps {
  /** Project enumeration — defaults to the config-loader registry. */
  listProjects: () => BeadsWatcherProject[];
  /**
   * DB used by the default recount sink (change-only snapshot writer). Ignored
   * when `onRecount` is supplied.
   */
  db?: Db;
  /**
   * Recount sink override (test seam). When omitted and `db` is present, the
   * default sink is `recordProjectStatusFromBeads(db, ...)` — this is the wiring
   * of the beads-watcher recount into the status-snapshots writer.
   */
  onRecount?: (project: string, counts: BeadUnlinkedCounts) => void;
  /** Debounce window for fs events (default 300ms). */
  debounceMs?: number;
  /** Poll-fallback cadence (default 60s). */
  pollIntervalMs?: number;
}

export interface BeadsWatcherHandle {
  stop(): void;
}

function countsEqual(a: BeadUnlinkedCounts, b: BeadUnlinkedCounts): boolean {
  return (
    a.beadsReadyUnlinked === b.beadsReadyUnlinked &&
    a.beadsBlockedUnlinked === b.beadsBlockedUnlinked
  );
}

/**
 * Start the beads watcher: a per-project `.beads/` directory watch (filtered
 * to `issues.jsonl`) plus an unconditional poll fallback, feeding recounts to
 * the status-snapshots writer.
 *
 * Recounts fire the sink only when the in-memory counts actually change (a
 * cheap first gate — the writer still does the authoritative DB compare). A
 * failed read keeps the last good counts and fires nothing.
 */
export function startBeadsWatcher(deps: BeadsWatcherDeps): BeadsWatcherHandle {
  const debounceMs = deps.debounceMs ?? DEBOUNCE_MS;
  const pollIntervalMs = deps.pollIntervalMs ?? POLL_INTERVAL_MS;
  const ac = new AbortController();

  const db = deps.db;
  const sink: (project: string, counts: BeadUnlinkedCounts) => void =
    deps.onRecount ??
    (db
      ? (project, counts) => {
          void recordProjectStatusFromBeads(db, project, counts).catch((err) => {
            log.warn({ project, err }, "beads-watcher: snapshot write failed");
          });
        }
      : () => {});

  // Per-project last good counts — fail-open baseline + change gate.
  const lastCounts = new Map<string, BeadUnlinkedCounts>();

  function recount(project: BeadsWatcherProject): void {
    const counts = computeBeadCountsFromDisk(project.path);
    if (counts === null) return; // fail-open: keep previous
    const prev = lastCounts.get(project.code);
    if (prev && countsEqual(prev, counts)) return; // no change
    lastCounts.set(project.code, counts);
    try {
      sink(project.code, counts);
    } catch (err) {
      log.warn({ project: project.code, err }, "beads-watcher: recount sink threw");
    }
  }

  let projects: BeadsWatcherProject[];
  try {
    projects = deps.listProjects();
  } catch (err) {
    log.warn({ err }, "beads-watcher: listProjects failed; watcher inert");
    projects = [];
  }

  for (const project of projects) {
    const beadsDir = join(project.path, ".beads");

    // Poll fallback is unconditional — started outside the fs.watch try so it
    // still bounds staleness even when the dir is absent or the watch errors.
    const pollTimer = setInterval(() => recount(project), pollIntervalMs);
    ac.signal.addEventListener("abort", () => clearInterval(pollTimer), {
      once: true,
    });

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRecount = (): void => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        recount(project);
      }, debounceMs);
    };
    ac.signal.addEventListener(
      "abort",
      () => {
        if (debounceTimer) clearTimeout(debounceTimer);
      },
      { once: true },
    );

    void (async () => {
      // Best-effort initial recount so the baseline is set before any event.
      recount(project);

      // Missing `.beads/` skips cleanly — no watch, poll fallback still runs.
      try {
        await stat(beadsDir);
      } catch {
        log.debug(
          { project: project.code, beadsDir },
          "beads-watcher: no .beads/ dir; poll-only",
        );
        return;
      }

      try {
        const watcher = watch(beadsDir, { signal: ac.signal });
        for await (const event of watcher) {
          if (event.filename !== ISSUES_FILE) continue;
          scheduleRecount();
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        log.warn(
          { project: project.code, err },
          "beads-watcher: watch terminated (poll fallback continues)",
        );
      }
    })();
  }

  log.info(
    { projectCount: projects.length, pollIntervalMs, debounceMs },
    "beads-watcher started",
  );

  return {
    stop() {
      ac.abort();
      log.info("beads-watcher stopped");
    },
  };
}
