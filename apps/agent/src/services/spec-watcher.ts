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

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { createLogger } from "@nexus/core";
import { sendTtsNotification } from "../notifications/channels/tts";

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

/** Load project registry from ~/.claude/scripts/config/projects.json. */
function loadProjectRegistry(): ProjectPath[] {
  const registryPath = join(
    homedir(),
    ".claude/scripts/config/projects.json",
  );

  try {
    const contents = readFileSync(registryPath, "utf8");
    const parsed = JSON.parse(contents) as {
      projects: Array<{ code: string; name: string; path: string }>;
    };

    return parsed.projects
      .map((p) => ({
        code: p.code,
        name: p.name,
        cwd: p.path.replace(/^~/, homedir()),
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
    const proc = Bun.spawn(["openspec", "list", "--json"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });

    // Race subprocess against a timeout.
    const timeoutPromise = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), SUBPROCESS_TIMEOUT_MS);
    });

    const resultPromise = (async () => {
      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        log.debug({ cwd, exitCode }, "openspec list --json exited with non-zero status");
        return [];
      }
      return parseSpecList(stdout);
    })();

    const result = await Promise.race([resultPromise, timeoutPromise]);
    if (result === null) {
      log.warn({ cwd }, "openspec list --json timed out after 5s");
      proc.kill();
      return [];
    }
    return result;
  } catch (err) {
    log.debug({ cwd, error: err }, "openspec list --json IO error");
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
      createdAt: new Date(),
      sentAt: null,
    };
    await sendTtsNotification(stubRow);
  } catch (err) {
    log.warn({ error: err }, "Failed to send spec-watcher TTS notification");
  }
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
 */
export function startSpecWatcher(): SpecWatcherService {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let firstTick = true;

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

  log.info({ intervalSecs: POLL_INTERVAL_MS / 1000 }, "Spec-watcher service started");

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      log.info("Spec-watcher service stopped");
    },
  };
}

// Exported for testing.
export { processProjectSpecs, loadProjectRegistry, pollProjectSpecs, projectState as _projectState };
