/**
 * Spec Watcher Service — lifecycle entry point.
 *
 * Proactively polls openspec status across all registered projects, detects
 * state transitions (NewSpec, Removed, Progress, AllComplete, HashChanged),
 * and emits `SpecTransition` lifecycle events on transitions (dashboard-only,
 * no TTS). Design: 60s poll interval,
 * staggered batches of 4 projects (200ms inter-batch delay); only projects
 * with an `openspec/` dir are polled. State is in-memory (per-project spec
 * snapshots); the first tick populates initial state without emitting.
 *
 * This module owns the shared projectState map, the polling loop, and the
 * SpecWatcherService lifecycle interface, and re-exports all public symbols
 * for backward-compatible consumer imports of "./services/spec-watcher".
 */

import type { Db } from "@nexus/db";
import { createLogger } from "@nexus/core/node";
import { lifecycleBus } from "../lifecycle-bus";
import { POLL_INTERVAL_MS, BATCH_SIZE, BATCH_DELAY_MS } from "./constants";
import { parseSpecList as _parseSpecList, processProjectSpecs as _processProjectSpecs, type SpecSnapshot, type SpecEvent } from "./parser";
import { pollProjectSpecs as _pollProjectSpecs, loadProjectRegistry as _loadProjectRegistry, loadProjectRegistryFromDb as _loadProjectRegistryFromDb, type ProjectPath } from "./poller";
import { startChangesFsWatchers as _startChangesFsWatchers, refreshSingleSpec as _refreshSingleSpec } from "./watcher";

const log = createLogger("agent:spec-watcher");

// ---------------------------------------------------------------------------
// Shared in-memory state
// ---------------------------------------------------------------------------

/** Per-project tracking state: spec name -> TrackedSpec. */
const projectState = new Map<string, Map<string, {
  name: string;
  completedTasks: number;
  totalTasks: number;
  proposalHash: string | null;
}>>();

// ---------------------------------------------------------------------------
// Public API wrappers (thread projectState implicitly for backward compat)
// ---------------------------------------------------------------------------

/**
 * Adapter: original public signature (4 args) → internal (5 args with state).
 * Consumers (tests, routes) call this form; the lifecycle loop calls _processProjectSpecs directly.
 */
export function processProjectSpecs(
  project: string,
  cwd: string,
  currentSpecs: SpecSnapshot[],
  firstTick: boolean,
): SpecEvent[] {
  return _processProjectSpecs(project, cwd, currentSpecs, firstTick, projectState);
}

/** Adapter: thread projectState into startChangesFsWatchers. */
export function startChangesFsWatchers(): () => void {
  return _startChangesFsWatchers(projectState);
}

/**
 * Adapter: thread projectState into refreshSingleSpec — the exact targeted
 * refresh the debounced fs.watch callback invokes. Exposed so tests drive it
 * deterministically (skipping the non-deterministic OS event + debounce timer).
 */
export function refreshSingleSpec(
  project: ProjectPath,
  specName: string,
): Promise<void> {
  return _refreshSingleSpec(project, specName, projectState);
}

// ---------------------------------------------------------------------------
// Re-exports (backward compat — consumer imports resolve unchanged)
// ---------------------------------------------------------------------------

export { parseSpecList, parseSpecFromPath, parseTaskCounts } from "./parser";
export type { SpecSnapshot } from "./parser";
export {
  loadProjectRegistry,
  loadProjectRegistryFromDb,
  pollProjectSpecs,
  scanResolvedRoots,
} from "./poller";
export { loadConfig, resolveRoots } from "./config";
export type { SpecWatcherConfig } from "./config";
export { _getWatchDegradedForTest } from "./watcher";

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export interface SpecWatcherService {
  stop(): void;
}

/** Delay helper. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Start the spec watcher service.
 *
 * Polls all registered projects every 60s, detects spec state transitions,
 * and emits `SpecTransition` lifecycle events (no TTS). First tick populates
 * initial state silently.
 *
 * Also installs per-project `fs.watch` watchers on `openspec/changes/` so
 * edits to proposals/tasks update the in-memory state within ~300ms
 * without waiting for the next poll cycle.
 */
export function startSpecWatcher(db?: Db): SpecWatcherService {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let firstTick = true;
  let stopFsWatchers: (() => void) | null = null;

  async function tick(): Promise<void> {
    if (stopped) return;

    // Registry-first when a Db is wired (production path); the registry-backed
    // loader falls back to the static projects.json internally when the
    // registry is empty. Without a Db (tests / legacy callers) use the static
    // loader directly so behaviour is unchanged.
    const projects = db
      ? await _loadProjectRegistryFromDb(db)
      : _loadProjectRegistry();
    if (projects.length === 0) {
      log.debug("No projects with openspec/ directory found, skipping poll");
      return;
    }

    log.debug({ count: projects.length }, "Polling projects for spec status");

    const allEvents: SpecEvent[] = [];

    for (let i = 0; i < projects.length; i += BATCH_SIZE) {
      if (stopped) break;

      const batch = projects.slice(i, i + BATCH_SIZE);
      for (const project of batch) {
        const specs = await _pollProjectSpecs(project.cwd);
        const events = _processProjectSpecs(
          project.code,
          project.cwd,
          specs,
          firstTick,
          projectState,
        );
        allEvents.push(...events);
      }

      if (i + BATCH_SIZE < projects.length) {
        await delay(BATCH_DELAY_MS);
      }
    }

    if (firstTick) {
      log.info(
        { projectCount: projects.length },
        "Spec-watcher initial state populated",
      );
      firstTick = false;
      return;
    }

    if (allEvents.length > 0) {
      log.info(
        { eventCount: allEvents.length },
        "Spec-watcher detected events across projects",
      );

      for (const ev of allEvents) {
        lifecycleBus.emit("SpecTransition", {
          project: ev.project,
          specName: ev.name,
          transition: ev.type,
          completed: "completed" in ev ? ev.completed : undefined,
          total: "total" in ev ? ev.total : undefined,
        });
      }
    }
  }

  async function schedule(): Promise<void> {
    if (stopped) return;

    try {
      await tick();
    } catch (err) {
      log.error({ error: err }, "spec-watcher: tick failed");
    }

    if (!stopped) {
      timer = setTimeout(() => {
        schedule().catch((err) => {
          log.error({ error: err }, "spec-watcher: schedule failed");
        });
      }, POLL_INTERVAL_MS);
    }
  }

  schedule().catch((err) => {
    log.error({ error: err }, "spec-watcher: initial tick failed");
  });

  // Install fs.watch for every project after a short delay so the initial
  // poll tick has a chance to populate `projectState` first.
  setTimeout(() => {
    if (stopped) return;
    try {
      stopFsWatchers = startChangesFsWatchers();
    } catch (err) {
      log.warn({ error: err }, "spec-watcher: failed to install fs watchers");
    }
  }, 500);

  log.info({ intervalSecs: POLL_INTERVAL_MS / 1000 }, "Spec-watcher service started");

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      if (stopFsWatchers) {
        try {
          stopFsWatchers();
        } catch {
          // Ignore close errors during shutdown.
        }
        stopFsWatchers = null;
      }
      log.info("Spec-watcher service stopped");
    },
  };
}

// ---------------------------------------------------------------------------
// Test-only exports (backward compat)
// ---------------------------------------------------------------------------

/** Exported for testing — the shared module-level state map. */
export { projectState as _projectState };
