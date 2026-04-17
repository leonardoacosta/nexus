/**
 * Spec Watcher Service
 *
 * Proactively polls openspec status across all registered projects,
 * detects state transitions (NewSpec, Removed, Progress, AllComplete,
 * HashChanged), and fires TTS notifications on transitions.
 *
 * Design: 60-second poll interval, staggered batches of 4 projects
 * with 200ms inter-batch delay. Only projects that have an `openspec/`
 * directory are polled.
 *
 * State is tracked in memory (per-project spec snapshots). The first
 * tick is used to populate initial state without emitting events.
 */

import { existsSync, readFileSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { createLogger } from "@nexus/core";
import { sendTtsNotification } from "../notifications/channels/tts";
import { lifecycleBus } from "./lifecycle-bus";
import { execText } from "../utils/exec";
import { getProjects } from "./config-loader";

const log = createLogger("agent:spec-watcher");

/** How often to run a full poll cycle (ms). */
const POLL_INTERVAL_MS = 60_000;

/** Max projects to poll in one batch before sleeping. */
const BATCH_SIZE = 4;

/** Delay between batches (ms). */
const BATCH_DELAY_MS = 200;

/** Subprocess timeout for `openspec list --json` (ms). */
const SUBPROCESS_TIMEOUT_MS = 5_000;

/** Delay after collecting all events before sending a batched TTS notification (ms). */
const COALESCE_DELAY_MS = 1_000;

/**
 * Debounce applied to per-spec file-watch events. Burst writes (e.g. editor
 * saves, `bd sync`) can fire the watcher many times in rapid succession;
 * we coalesce them into a single targeted refresh.
 */
const WATCH_DEBOUNCE_MS = 300;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SpecSnapshot {
  name: string;
  status: string;
  completedTasks: number;
  totalTasks: number;
  lastModified?: string;
}

interface ProjectPath {
  code: string;
  name: string;
  cwd: string;
}

/** A detected state change in a project's spec landscape. */
type SpecEvent =
  | { type: "new_spec"; project: string; name: string }
  | { type: "removed"; project: string; name: string }
  | { type: "progress"; project: string; name: string; completed: number; total: number }
  | { type: "all_complete"; project: string; name: string }
  | { type: "hash_changed"; project: string; name: string };

function eventToMessage(event: SpecEvent): string {
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

// ---------------------------------------------------------------------------
// In-memory state for change detection
// ---------------------------------------------------------------------------

interface TrackedSpec {
  name: string;
  completedTasks: number;
  totalTasks: number;
  proposalHash: string | null;
}

/** Per-project tracking state: spec name -> TrackedSpec. */
const projectState = new Map<string, Map<string, TrackedSpec>>();

// ---------------------------------------------------------------------------
// Project discovery
// ---------------------------------------------------------------------------

/** Load project registry from config-loader cache. */
function loadProjectRegistry(): ProjectPath[] {
  try {
    return getProjects()
      .map((p) => ({
        code: p.code,
        name: p.name,
        cwd: p.path,
      }))
      .filter((p) => existsSync(join(p.cwd, "openspec")));
  } catch (err) {
    log.debug({ error: err }, "spec-watcher: failed to load project registry");
    return [];
  }
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

/**
 * Run `openspec list --json` in a project directory and parse the output
 * into SpecSnapshot[]. Returns an empty array on any failure.
 */
async function pollProjectSpecs(cwd: string): Promise<SpecSnapshot[]> {
  const openspecDir = join(cwd, "openspec");
  if (!existsSync(openspecDir)) return [];

  try {
    const stdout = await execText("openspec", ["list", "--json"], {
      cwd,
      timeout: SUBPROCESS_TIMEOUT_MS,
    });
    return parseSpecList(stdout);
  } catch (err) {
    log.debug({ cwd, error: err }, "openspec list --json failed");
    return [];
  }
}

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
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Hash computation
// ---------------------------------------------------------------------------

/** Read proposal.md from disk and compute its SHA-256 hash. */
function readProposalHash(cwd: string, specName: string): string | null {
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
 */
function processProjectSpecs(
  project: string,
  cwd: string,
  currentSpecs: SpecSnapshot[],
  firstTick: boolean,
): SpecEvent[] {
  const events: SpecEvent[] = [];

  // Get or create per-project state.
  let state = projectState.get(project);
  if (!state) {
    state = new Map();
    projectState.set(project, state);
  }

  const currentNames = new Set(currentSpecs.map((s) => s.name));

  // Process each spec found on disk.
  for (const snap of currentSpecs) {
    const hash = readProposalHash(cwd, snap.name);
    const existing = state.get(snap.name);

    if (existing) {
      // Hash change detection: if hash changed and was previously tracked, flag it.
      if (
        hash !== null &&
        existing.proposalHash !== null &&
        hash !== existing.proposalHash &&
        !firstTick
      ) {
        events.push({ type: "hash_changed", project, name: snap.name });
      }

      // Task progress detection.
      if (!firstTick) {
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

      // Update tracked state.
      existing.completedTasks = snap.completedTasks;
      existing.totalTasks = snap.totalTasks;
      existing.proposalHash = hash;
    } else {
      // New spec discovered.
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

  // Spec removal detection: tracked specs no longer on disk.
  for (const [name] of state) {
    if (!currentNames.has(name) && !firstTick) {
      events.push({ type: "removed", project, name });
      state.delete(name);
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// TTS notification
// ---------------------------------------------------------------------------

/**
 * Send a combined TTS notification for spec events.
 * Creates a minimal NotificationRow stub for the TTS channel.
 */
async function sendSpecTtsNotification(message: string): Promise<void> {
  try {
    // Create a minimal notification row for the TTS channel.
    const stubRow = {
      id: `spec-watcher-${Date.now()}`,
      title: "Spec Watcher",
      body: message,
      channel: "tts" as const,
      priority: "normal" as const,
      status: "queued" as const,
      project: null,
      // Spec-watcher service has no local agent context; pass null (global).
      agentId: null,
      createdAt: new Date(),
      sentAt: null,
    };
    await sendTtsNotification(stubRow);
  } catch (err) {
    log.warn({ error: err }, "Failed to send spec-watcher TTS notification");
  }
}

// ---------------------------------------------------------------------------
// fs.watch for openspec/changes/
// ---------------------------------------------------------------------------

/** A project whose fs.watch setup failed; poll-only fallback is in effect. */
interface WatchDegraded {
  code: string;
  reason: string;
}

const activeWatchers = new Map<string, FSWatcher>();
const watchDegraded = new Map<string, WatchDegraded>();
const pendingSpecRefresh = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Targeted re-poll of a single change directory. Runs `openspec show
 * <spec> --json` (not a full `openspec list`) so bursty writes across
 * many specs do not amplify into a full-registry scan.
 *
 * Any detected task-progress / completion transition is emitted onto
 * the lifecycle bus just like the poll loop.
 */
async function refreshSingleSpec(
  project: ProjectPath,
  specName: string,
): Promise<void> {
  try {
    const stdout = await execText("openspec", ["show", specName, "--json"], {
      cwd: project.cwd,
      timeout: SUBPROCESS_TIMEOUT_MS,
    });

    // Parse `openspec show <spec>` output — it may emit either a single
    // snapshot object or an array; normalize to array of `SpecSnapshot`.
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return;
    }
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    const snapshots: SpecSnapshot[] = [];
    for (const raw of arr) {
      if (typeof raw !== "object" || raw === null) continue;
      const item = raw as Record<string, unknown>;
      const name = typeof item.name === "string" ? item.name : specName;
      const lastModifiedRaw = item.lastModified ?? item.last_modified;
      snapshots.push({
        name,
        status: typeof item.status === "string" ? item.status : "unknown",
        completedTasks: Number(item.completedTasks ?? item.completed_tasks ?? 0),
        totalTasks: Number(item.totalTasks ?? item.total_tasks ?? 0),
        lastModified:
          typeof lastModifiedRaw === "string" ? lastModifiedRaw : undefined,
      });
    }

    if (snapshots.length === 0) {
      // Spec directory removed between the fs event and the re-poll. Fall
      // through to a full pollProjectSpecs() so the removal event fires.
      const full = await pollProjectSpecs(project.cwd);
      const events = processProjectSpecs(project.code, project.cwd, full, false);
      for (const ev of events) {
        lifecycleBus.emit("SpecTransition", {
          project: ev.project,
          specName: ev.name,
          transition: ev.type,
          completed: "completed" in ev ? ev.completed : undefined,
          total: "total" in ev ? ev.total : undefined,
        });
      }
      return;
    }

    // Run change detection restricted to the affected spec. We splice the
    // single snapshot into a current-spec-only array for processing so the
    // rest of the project's state is not touched.
    const state = projectState.get(project.code);
    const otherSpecs: SpecSnapshot[] = state
      ? [...state.values()]
          .filter((t) => t.name !== specName)
          .map((t) => ({
            name: t.name,
            status: "pending",
            completedTasks: t.completedTasks,
            totalTasks: t.totalTasks,
            lastModified: undefined,
          }))
      : [];
    const composite = [...otherSpecs, ...snapshots];
    const events = processProjectSpecs(project.code, project.cwd, composite, false);
    for (const ev of events) {
      if (ev.name !== specName) continue;
      lifecycleBus.emit("SpecTransition", {
        project: ev.project,
        specName: ev.name,
        transition: ev.type,
        completed: "completed" in ev ? ev.completed : undefined,
        total: "total" in ev ? ev.total : undefined,
      });
    }
  } catch (err) {
    log.debug(
      { project: project.code, spec: specName, error: err },
      "refreshSingleSpec failed",
    );
  }
}

/**
 * Install a shallow `fs.watch()` on `<project>/openspec/changes/` for
 * every registered project. Events are debounced per-spec (300ms) and
 * trigger a targeted `openspec show` refresh.
 *
 * ENOSPC (inotify limit exhaustion on Linux) is caught and recorded as a
 * degraded-watch state; the 60-second poll remains as a safety net so
 * the page still updates, just with higher latency.
 *
 * Returns a disposer that closes every watcher.
 */
export function startChangesFsWatchers(): () => void {
  const projects = loadProjectRegistry();

  for (const project of projects) {
    const changesDir = join(project.cwd, "openspec", "changes");
    if (!existsSync(changesDir)) continue;
    if (activeWatchers.has(project.code)) continue;

    try {
      // Shallow watch only — avoids amplifying inotify usage by descending
      // into every change's `specs/` subtree.
      const watcher = fsWatch(changesDir, { persistent: false }, (_event, filename) => {
        if (!filename) return;
        // `filename` is either the change directory itself or a file inside
        // it. We treat the first path segment as the spec name so edits
        // within `proposal.md`/`tasks.md` still trigger a refresh of the
        // parent change.
        const specName = filename.split(/[\\/]/)[0];
        if (!specName) return;

        const key = `${project.code}::${specName}`;
        const existing = pendingSpecRefresh.get(key);
        if (existing) clearTimeout(existing);

        pendingSpecRefresh.set(
          key,
          setTimeout(() => {
            pendingSpecRefresh.delete(key);
            refreshSingleSpec(project, specName).catch((err) => {
              log.debug(
                { project: project.code, spec: specName, error: err },
                "debounced spec refresh failed",
              );
            });
          }, WATCH_DEBOUNCE_MS),
        );
      });
      watcher.on("error", (err) => {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOSPC") {
          log.warn(
            { project: project.code },
            "spec-watcher: ENOSPC on fs.watch -- degrading to poll-only for this project",
          );
          watchDegraded.set(project.code, {
            code: project.code,
            reason: "ENOSPC",
          });
          watcher.close();
          activeWatchers.delete(project.code);
        } else {
          log.debug(
            { project: project.code, error: err },
            "spec-watcher: fs.watch emitted error",
          );
        }
      });
      activeWatchers.set(project.code, watcher);
      log.info(
        { project: project.code, dir: changesDir },
        "spec-watcher: fs.watch installed on openspec/changes/",
      );
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOSPC") {
        log.warn(
          { project: project.code },
          "spec-watcher: ENOSPC creating fs.watch -- continuing with 60s poll only",
        );
        watchDegraded.set(project.code, {
          code: project.code,
          reason: "ENOSPC",
        });
      } else {
        log.warn(
          {
            project: project.code,
            error: err instanceof Error ? err.message : String(err),
          },
          "spec-watcher: failed to install fs.watch, continuing with poll",
        );
        watchDegraded.set(project.code, {
          code: project.code,
          reason:
            err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return function stopFsWatchers() {
    for (const [code, timer] of pendingSpecRefresh) {
      clearTimeout(timer);
      pendingSpecRefresh.delete(code);
    }
    for (const [code, watcher] of activeWatchers) {
      try {
        watcher.close();
      } catch {
        // Swallow close() errors — shutting down, nothing to do.
      }
      activeWatchers.delete(code);
    }
    watchDegraded.clear();
  };
}

/** Test-only accessor: which projects are watch-degraded. */
export function _getWatchDegradedForTest(): WatchDegraded[] {
  return [...watchDegraded.values()];
}

// ---------------------------------------------------------------------------
// Service lifecycle
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
 * and fires TTS notifications. First tick populates initial state silently.
 *
 * Also installs per-project `fs.watch` watchers on `openspec/changes/` so
 * edits to proposals/tasks update the in-memory state within ~300ms
 * without waiting for the next poll cycle.
 */
export function startSpecWatcher(): SpecWatcherService {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let firstTick = true;
  let stopFsWatchers: (() => void) | null = null;

  async function tick(): Promise<void> {
    if (stopped) return;

    const projects = loadProjectRegistry();
    if (projects.length === 0) {
      log.debug("No projects with openspec/ directory found, skipping poll");
      return;
    }

    log.debug({ count: projects.length }, "Polling projects for spec status");

    const allEvents: SpecEvent[] = [];

    // Staggered batching: poll BATCH_SIZE projects at a time.
    for (let i = 0; i < projects.length; i += BATCH_SIZE) {
      if (stopped) break;

      const batch = projects.slice(i, i + BATCH_SIZE);
      for (const project of batch) {
        const specs = await pollProjectSpecs(project.cwd);
        const events = processProjectSpecs(
          project.code,
          project.cwd,
          specs,
          firstTick,
        );
        allEvents.push(...events);
      }

      // Inter-batch delay to avoid hammering.
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

    // Coalesce and send TTS notifications.
    if (allEvents.length > 0) {
      log.info(
        { eventCount: allEvents.length },
        "Spec-watcher detected events across projects",
      );

      // Emit each event to the lifecycle bus for federation
      for (const ev of allEvents) {
        lifecycleBus.emit("SpecTransition", {
          project: ev.project,
          specName: ev.name,
          transition: ev.type,
          completed: "completed" in ev ? ev.completed : undefined,
          total: "total" in ev ? ev.total : undefined,
        });
      }

      // Coalesce: wait briefly, then send as a single batched message.
      await delay(COALESCE_DELAY_MS);

      const combined = allEvents.map(eventToMessage).join(". ");
      await sendSpecTtsNotification(combined);
    }
  }

  // Schedule the polling loop.
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

  // Start immediately.
  schedule().catch((err) => {
    log.error({ error: err }, "spec-watcher: initial tick failed");
  });

  // Install fs.watch for every project after a short delay so the initial
  // poll tick has a chance to populate `projectState` first. The fs
  // watchers themselves do not read state; the delay just avoids a
  // spurious "new_spec" flood when the first watch event races with the
  // first poll.
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

// Exported for testing.
export { processProjectSpecs, loadProjectRegistry, pollProjectSpecs, projectState as _projectState };
