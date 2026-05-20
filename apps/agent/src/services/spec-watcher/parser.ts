/**
 * Pure parsing and change-detection logic for the spec-watcher service.
 *
 * No side effects: no subprocess spawning, no fs.watch, no TTS, no network.
 * All functions are deterministic given the same inputs.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SpecSnapshot {
  name: string;
  status: string;
  completedTasks: number;
  totalTasks: number;
  lastModified?: string;
  /**
   * Marker tri-state booleans (agent-payload-completeness): true iff the
   * corresponding markdown artifact exists in the spec directory at scan
   * time. Optional on the in-memory type so legacy snapshot constructors
   * (tests, fs-watch synthesized rows) continue to compile, but the
   * `pollProjectSpecs` decoration step and the `handleListSpecs` wire
   * normalisation ensure every row emitted on `GET /specs` carries them
   * as non-optional booleans — the Swift `SpecSummary` decoder pins them
   * non-optional via PayloadDecodeTests v2.
   */
  has_proposal?: boolean;
  has_design?: boolean;
  has_tasks?: boolean;
}

/** A detected state change in a project's spec landscape. */
export type SpecEvent =
  | { type: "new_spec"; project: string; name: string }
  | { type: "removed"; project: string; name: string }
  | { type: "progress"; project: string; name: string; completed: number; total: number }
  | { type: "all_complete"; project: string; name: string }
  | { type: "hash_changed"; project: string; name: string };

export interface TrackedSpec {
  name: string;
  completedTasks: number;
  totalTasks: number;
  proposalHash: string | null;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse `openspec list --json` output into spec snapshots.
 * Handles both camelCase and snake_case keys, and missing fields gracefully.
 */
export function parseSpecList(json: string): SpecSnapshot[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  const results: SpecSnapshot[] = [];
  for (const raw of parsed) {
    if (typeof raw !== "object" || raw === null) continue;
    const item = raw as Record<string, unknown>;
    const name = typeof item.name === "string" ? item.name : "";
    if (!name) continue;

    const lastModifiedRaw = item.lastModified ?? item.last_modified;
    results.push({
      name,
      status: typeof item.status === "string" ? item.status : "unknown",
      completedTasks: Number(item.completedTasks ?? item.completed_tasks ?? 0),
      totalTasks: Number(item.totalTasks ?? item.total_tasks ?? 0),
      lastModified: typeof lastModifiedRaw === "string" ? lastModifiedRaw : undefined,
      // Marker booleans default to false here — the parser is pure and has
      // no filesystem access. `pollProjectSpecs` decorates each snapshot
      // with the real existsSync() result before the route emits it.
      has_proposal: Boolean(item.has_proposal ?? false),
      has_design: Boolean(item.has_design ?? false),
      has_tasks: Boolean(item.has_tasks ?? false),
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Hash computation
// ---------------------------------------------------------------------------

/** Read proposal.md from disk and compute its SHA-256 hash. */
export function readProposalHash(cwd: string, specName: string): string | null {
  const proposalPath = join(cwd, "openspec", "changes", specName, "proposal.md");
  try {
    const content = readFileSync(proposalPath);
    return createHash("sha256").update(content).digest("hex");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Change detection
// ---------------------------------------------------------------------------

/**
 * Process specs from a single project against in-memory state, returning
 * detected events. Updates the in-memory state as a side effect.
 *
 * @param project  Project code used as key in projectState.
 * @param cwd      Project working directory (used for readProposalHash).
 * @param currentSpecs  Current snapshot list from openspec.
 * @param firstTick  If true, silently populates state without emitting events.
 * @param projectState  Mutable map passed in from the lifecycle layer.
 */
export function processProjectSpecs(
  project: string,
  cwd: string,
  currentSpecs: SpecSnapshot[],
  firstTick: boolean,
  projectState: Map<string, Map<string, TrackedSpec>>,
): SpecEvent[] {
  const events: SpecEvent[] = [];

  let state = projectState.get(project);
  if (!state) {
    state = new Map();
    projectState.set(project, state);
  }

  const currentNames = new Set(currentSpecs.map((s) => s.name));

  for (const snap of currentSpecs) {
    const hash = readProposalHash(cwd, snap.name);
    const existing = state.get(snap.name);

    if (existing) {
      appendHashChangedEvent(events, existing, hash, snap, project, firstTick);
      appendProgressEvents(events, existing, snap, project, firstTick);

      existing.completedTasks = snap.completedTasks;
      existing.totalTasks = snap.totalTasks;
      existing.proposalHash = hash;
    } else {
      state.set(snap.name, {
        name: snap.name,
        completedTasks: snap.completedTasks,
        totalTasks: snap.totalTasks,
        proposalHash: hash,
      });
      if (!firstTick) {
        events.push({ type: "new_spec", project, name: snap.name });
      }
    }
  }

  for (const [name] of state) {
    if (!currentNames.has(name) && !firstTick) {
      events.push({ type: "removed", project, name });
      state.delete(name);
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// Helpers (nesting reduction)
// ---------------------------------------------------------------------------

function appendHashChangedEvent(
  events: SpecEvent[],
  existing: TrackedSpec,
  hash: string | null,
  snap: SpecSnapshot,
  project: string,
  firstTick: boolean,
): void {
  if (
    hash !== null &&
    existing.proposalHash !== null &&
    hash !== existing.proposalHash &&
    !firstTick
  ) {
    events.push({ type: "hash_changed", project, name: snap.name });
  }
}

function appendProgressEvents(
  events: SpecEvent[],
  existing: TrackedSpec,
  snap: SpecSnapshot,
  project: string,
  firstTick: boolean,
): void {
  if (firstTick) return;

  const wasIncomplete =
    existing.completedTasks < existing.totalTasks || existing.totalTasks === 0;
  const isAllComplete =
    snap.completedTasks === snap.totalTasks && snap.totalTasks > 0;

  if (isAllComplete && wasIncomplete) {
    events.push({ type: "all_complete", project, name: snap.name });
  } else if (snap.completedTasks > existing.completedTasks) {
    events.push({
      type: "progress",
      project,
      name: snap.name,
      completed: snap.completedTasks,
      total: snap.totalTasks,
    });
  }
}

// ---------------------------------------------------------------------------
// TTS message formatting
// ---------------------------------------------------------------------------

export function eventToMessage(event: SpecEvent): string {
  switch (event.type) {
    case "new_spec":
      return `New spec ${event.name} in ${event.project}`;
    case "removed":
      return `${event.project}: ${event.name} archived`;
    case "progress":
      return `${event.project}: ${event.name} progress ${event.completed}/${event.total}`;
    case "all_complete":
      return `${event.project}: ${event.name} all tasks complete`;
    case "hash_changed":
      return `Spec ${event.name} in ${event.project} was modified -- needs re-review`;
  }
}
