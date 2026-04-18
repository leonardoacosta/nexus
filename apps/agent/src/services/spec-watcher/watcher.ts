/**
 * File-system watcher for openspec/changes/ directories.
 *
 * Installs a shallow fs.watch() per project, debounces events, and triggers
 * targeted single-spec refreshes. Falls back to poll-only when inotify
 * limits are exhausted (ENOSPC).
 */

import { existsSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { createLogger } from "@nexus/core/node";
import { execText } from "../../utils/exec";
import { lifecycleBus } from "../lifecycle-bus";
import { processProjectSpecs, type SpecSnapshot } from "./parser";
import { pollProjectSpecs, loadProjectRegistry, type ProjectPath } from "./poller";
import { SUBPROCESS_TIMEOUT_MS, WATCH_DEBOUNCE_MS } from "./constants";

const log = createLogger("agent:spec-watcher");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A project whose fs.watch setup failed; poll-only fallback is in effect. */
export interface WatchDegraded {
  code: string;
  reason: string;
}

interface TrackedSpec {
  name: string;
  completedTasks: number;
  totalTasks: number;
  proposalHash: string | null;
}

/** Shorthand for the shared projectState map type. */
type ProjectStateMap = Map<string, Map<string, TrackedSpec>>;

// ---------------------------------------------------------------------------
// Module-level watcher state
// ---------------------------------------------------------------------------

export const activeWatchers = new Map<string, FSWatcher>();
export const watchDegraded = new Map<string, WatchDegraded>();
export const pendingSpecRefresh = new Map<string, ReturnType<typeof setTimeout>>();

// ---------------------------------------------------------------------------
// Single-spec refresh
// ---------------------------------------------------------------------------

/**
 * Targeted re-poll of a single change directory. Runs `openspec show
 * <spec> --json` so bursty writes do not amplify into a full-registry scan.
 *
 * Detected transitions are emitted onto the lifecycle bus.
 */
export async function refreshSingleSpec(
  project: ProjectPath,
  specName: string,
  projectState: ProjectStateMap,
): Promise<void> {
  try {
    const snapshots = await fetchSpecSnapshots(project, specName);
    if (snapshots === null) return; // execText failed — already debug-logged
    if (snapshots.length === 0) {
      await handleEmptySnapshots(project, projectState);
      return;
    }
    emitSpecEvents(project, specName, snapshots, projectState);
  } catch (err) {
    log.debug({ project: project.code, spec: specName, error: err }, "refreshSingleSpec failed");
  }
}

// ---------------------------------------------------------------------------
// Helpers (nesting reduction)
// ---------------------------------------------------------------------------

async function fetchSpecSnapshots(
  project: ProjectPath,
  specName: string,
): Promise<SpecSnapshot[] | null> {
  let stdout: string;
  try {
    stdout = await execText("openspec", ["show", specName, "--json"], {
      cwd: project.cwd,
      timeout: SUBPROCESS_TIMEOUT_MS,
    });
  } catch (err) {
    log.debug({ project: project.code, spec: specName, error: err }, "openspec show failed");
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }

  return normalizeShowOutput(Array.isArray(parsed) ? parsed : [parsed], specName);
}

function normalizeShowOutput(arr: unknown[], fallbackName: string): SpecSnapshot[] {
  const snapshots: SpecSnapshot[] = [];
  for (const raw of arr) {
    if (typeof raw !== "object" || raw === null) continue;
    const item = raw as Record<string, unknown>;
    const name = typeof item.name === "string" ? item.name : fallbackName;
    const lastModifiedRaw = item.lastModified ?? item.last_modified;
    snapshots.push({
      name,
      status: typeof item.status === "string" ? item.status : "unknown",
      completedTasks: Number(item.completedTasks ?? item.completed_tasks ?? 0),
      totalTasks: Number(item.totalTasks ?? item.total_tasks ?? 0),
      lastModified: typeof lastModifiedRaw === "string" ? lastModifiedRaw : undefined,
    });
  }
  return snapshots;
}

async function handleEmptySnapshots(project: ProjectPath, projectState: ProjectStateMap): Promise<void> {
  // Spec dir removed — full scan so removal event fires correctly.
  const full = await pollProjectSpecs(project.cwd);
  const events = processProjectSpecs(project.code, project.cwd, full, false, projectState);
  for (const ev of events) {
    lifecycleBus.emit("SpecTransition", { project: ev.project, specName: ev.name, transition: ev.type, completed: "completed" in ev ? ev.completed : undefined, total: "total" in ev ? ev.total : undefined });
  }
}

function emitSpecEvents(project: ProjectPath, specName: string, snapshots: SpecSnapshot[], projectState: ProjectStateMap): void {
  const state = projectState.get(project.code);
  const otherSpecs: SpecSnapshot[] = state
    ? [...state.values()].filter((t) => t.name !== specName).map((t) => ({ name: t.name, status: "pending", completedTasks: t.completedTasks, totalTasks: t.totalTasks, lastModified: undefined }))
    : [];
  const events = processProjectSpecs(project.code, project.cwd, [...otherSpecs, ...snapshots], false, projectState);
  for (const ev of events) {
    if (ev.name !== specName) continue;
    lifecycleBus.emit("SpecTransition", { project: ev.project, specName: ev.name, transition: ev.type, completed: "completed" in ev ? ev.completed : undefined, total: "total" in ev ? ev.total : undefined });
  }
}

// ---------------------------------------------------------------------------
// fs.watch installer
// ---------------------------------------------------------------------------

/**
 * Install a shallow `fs.watch()` on `<project>/openspec/changes/` for every
 * registered project. Events are debounced per-spec (300ms) and trigger a
 * targeted `openspec show` refresh.
 *
 * ENOSPC is caught and recorded as degraded-watch; poll loop remains as fallback.
 * Returns a disposer that closes every watcher.
 */
export function startChangesFsWatchers(projectState: ProjectStateMap): () => void {
  const projects = loadProjectRegistry();
  for (const project of projects) {
    installProjectWatcher(project, projectState);
  }
  return function stopFsWatchers() {
    for (const [code, timer] of pendingSpecRefresh) {
      clearTimeout(timer);
      pendingSpecRefresh.delete(code);
    }
    for (const [code, watcher] of activeWatchers) {
      try { watcher.close(); } catch { /* shutting down */ }
      activeWatchers.delete(code);
    }
    watchDegraded.clear();
  };
}

function installProjectWatcher(project: ProjectPath, projectState: ProjectStateMap): void {
  const changesDir = join(project.cwd, "openspec", "changes");
  if (!existsSync(changesDir) || activeWatchers.has(project.code)) return;

  try {
    const watcher = fsWatch(changesDir, { persistent: false }, (_event, filename) => {
      if (!filename) return;
      const specName = filename.split(/[\\/]/)[0];
      if (specName) scheduleSpecRefresh(project, specName, projectState);
    });
    watcher.on("error", (err) => handleWatcherError(project, err, watcher));
    activeWatchers.set(project.code, watcher);
    log.info({ project: project.code, dir: changesDir }, "spec-watcher: fs.watch installed");
  } catch (err) {
    recordWatchFailure(project, err);
  }
}

function scheduleSpecRefresh(
  project: ProjectPath,
  specName: string,
  projectState: ProjectStateMap,
): void {
  const key = `${project.code}::${specName}`;
  const existing = pendingSpecRefresh.get(key);
  if (existing) clearTimeout(existing);
  pendingSpecRefresh.set(
    key,
    setTimeout(() => {
      pendingSpecRefresh.delete(key);
      refreshSingleSpec(project, specName, projectState).catch((err) => {
        log.debug({ project: project.code, spec: specName, error: err }, "debounced refresh failed");
      });
    }, WATCH_DEBOUNCE_MS),
  );
}

function handleWatcherError(project: ProjectPath, err: Error, watcher: FSWatcher): void {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOSPC") {
    log.warn({ project: project.code }, "spec-watcher: ENOSPC on fs.watch -- poll-only fallback");
    watchDegraded.set(project.code, { code: project.code, reason: "ENOSPC" });
    watcher.close();
    activeWatchers.delete(project.code);
  } else {
    log.debug({ project: project.code, error: err }, "spec-watcher: fs.watch emitted error");
  }
}

function recordWatchFailure(project: ProjectPath, err: unknown): void {
  const reason = err instanceof Error ? err.message : String(err);
  const errCode = (err as NodeJS.ErrnoException).code;
  if (errCode === "ENOSPC") {
    log.warn({ project: project.code }, "spec-watcher: ENOSPC creating fs.watch -- poll-only");
    watchDegraded.set(project.code, { code: project.code, reason: "ENOSPC" });
  } else {
    log.warn({ project: project.code, error: reason }, "spec-watcher: failed to install fs.watch");
    watchDegraded.set(project.code, { code: project.code, reason });
  }
}

// ---------------------------------------------------------------------------
// Test accessor
// ---------------------------------------------------------------------------

/** Test-only accessor: which projects are watch-degraded. */
export function _getWatchDegradedForTest(): WatchDegraded[] {
  return [...watchDegraded.values()];
}
