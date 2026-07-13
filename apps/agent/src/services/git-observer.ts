/**
 * Git status observer.
 *
 * A 60s staggered poll over every registered project location present on the
 * LOCAL machine, deriving each project's current git state (branch, HEAD sha,
 * detached flag, dirty working-tree counts) via a single `git status
 * --porcelain=v2 --branch` spawn. Transitions between polls — branch switch,
 * new commit, detached head — are persisted to the append-only Postgres
 * `git_events` table; the current state lives only in an in-memory map folded
 * into the `GET /projects/:id/status` payload (fully reconstructible on the
 * next poll, so it is never persisted).
 *
 * Poll-only, NO fs.watch: dirty state is working-tree-wide and unobservable
 * from `.git/` events alone (see design.md § Poll-only observation). The 60s
 * cadence + staggered batches (BATCH_SIZE projects, BATCH_DELAY_MS between
 * batches) mirror the spec-watcher's shape; each project observation carries a
 * per-project timeout and fails open — a missing dir, non-repo, bare repo, or
 * git timeout skips that project and logs once, leaving others unaffected.
 *
 * The first observation of a project after agent start establishes a baseline
 * and emits NO event (there is no prior state to diff against).
 *
 * Identity keys on `project` name (the config-loader `code`), consistent with
 * `spec_sessions` / `project_status_snapshots` — deliberately not the registry
 * uuid, to keep the observer path free of DB joins. Peer agents each observe
 * only their own local locations (existing peer-to-peer topology semantics).
 *
 * Spec: openspec/changes/add-git-status-orbit/ (git-event-store delta).
 */

import { existsSync } from "node:fs";
import { createLogger } from "@nexus/core/node";
import type { GitDirtyCounts, GitStatusObject } from "@nexus/core";
import type { Db } from "@nexus/db";
import { gitEvents } from "@nexus/db";

const log = createLogger("agent:services:git-observer");

const POLL_INTERVAL_MS = 60_000;
/** Max projects observed per batch before sleeping (spec-watcher parity). */
const BATCH_SIZE = 4;
/** Delay between batches (ms). */
const BATCH_DELAY_MS = 200;
/** Per-project git subprocess budget; exceeded => fail-open skip. */
const PER_PROJECT_TIMEOUT_MS = 2_000;

// ---------------------------------------------------------------------------
// In-memory current-state registry (single observer per process)
// ---------------------------------------------------------------------------

const observedState = new Map<string, GitStatusObject>();

/**
 * Current observed git state for a project, or `undefined` when the project
 * has not been observed on this agent (its location is on another machine, is
 * not a repo, or the first poll has not run yet). Read by
 * `routes/project-status.ts` to fold the `git` object into the status payload.
 */
export function getObservedGitState(
  project: string,
): GitStatusObject | undefined {
  return observedState.get(project);
}

/** Test seam: clear the module-level current-state registry. */
export function __resetObservedGitState(): void {
  observedState.clear();
}

// ---------------------------------------------------------------------------
// Git plumbing
// ---------------------------------------------------------------------------

/** Observation snapshot (the wire `git` object minus its `observedAt`). */
export type GitObservation = Omit<GitStatusObject, "observedAt">;

/**
 * Parse `git status --porcelain=v2 --branch` output into a {@link GitObservation}.
 *
 * Pulls `# branch.oid` (HEAD sha), `# branch.head` (`(detached)` => detached),
 * and counts entry lines: `1 `/`2 `/`u ` are tracked modifications, `? ` are
 * untracked. Returns `null` when the output is missing the branch header
 * (not a v2 status block).
 */
export function parseGitStatusV2(raw: string): GitObservation | null {
  if (!raw) return null;
  let headSha: string | null = null;
  let branch: string | null = null;
  let detached = false;
  let sawHead = false;
  const dirty: GitDirtyCounts = { modified: 0, untracked: 0 };

  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("# branch.oid ")) {
      headSha = line.slice("# branch.oid ".length).trim();
      continue;
    }
    if (line.startsWith("# branch.head ")) {
      const name = line.slice("# branch.head ".length).trim();
      sawHead = true;
      if (name === "(detached)") {
        detached = true;
        branch = null;
      } else {
        branch = name;
      }
      continue;
    }
    if (line.startsWith("#")) continue;
    if (
      line.startsWith("1 ") ||
      line.startsWith("2 ") ||
      line.startsWith("u ")
    ) {
      dirty.modified++;
    } else if (line.startsWith("? ")) {
      dirty.untracked++;
    }
  }

  if (!sawHead || !headSha) return null;
  return { branch, headSha, detached, dirty };
}

/**
 * Observe one project's git state. Spawns `git status --porcelain=v2 --branch`
 * with `-C <path>` (arg-vector, no shell interpolation of the path) under a
 * per-project timeout. Returns `null` fail-open on: missing/non-existent path,
 * not a repo / bare repo (non-zero exit), timeout, or unparseable output.
 */
export async function observeGitState(
  path: string,
  timeoutMs: number = PER_PROJECT_TIMEOUT_MS,
): Promise<GitObservation | null> {
  if (!existsSync(path)) return null;

  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const proc = Bun.spawn(
      ["git", "-C", path, "status", "--porcelain=v2", "--branch"],
      { stdout: "pipe", stderr: "ignore", stdin: "ignore" },
    );
    timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* already exited */
      }
    }, timeoutMs);
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) return null;
    return parseGitStatusV2(stdout);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Transition detection
// ---------------------------------------------------------------------------

/** A detected transition, shaped for a `git_events` insert. */
export interface GitTransition {
  eventType: "branch_switch" | "new_commit" | "detached_head";
  fromRef: string | null;
  toRef: string | null;
  sha: string | null;
}

/**
 * Diff a project's previous observed state against the current one and return
 * the single transition to persist, or `null` for no change / baseline.
 *
 * Priority (one poll => at most one row): a move INTO detached head wins, then
 * a landing on a different branch (branch_switch — `fromRef` is `null` when the
 * previous state was detached), then a HEAD sha change on the same ref
 * (new_commit, including commits made while detached).
 */
export function detectGitTransition(
  prev: GitObservation | undefined,
  curr: GitObservation,
): GitTransition | null {
  if (!prev) return null; // first observation = baseline, no event

  if (curr.detached && !prev.detached) {
    return {
      eventType: "detached_head",
      fromRef: null,
      toRef: null,
      sha: curr.headSha,
    };
  }
  if (!curr.detached && (prev.detached || prev.branch !== curr.branch)) {
    return {
      eventType: "branch_switch",
      fromRef: prev.branch,
      toRef: curr.branch,
      sha: null,
    };
  }
  if (prev.headSha !== curr.headSha) {
    return {
      eventType: "new_commit",
      fromRef: null,
      toRef: null,
      sha: curr.headSha,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface GitObserverProject {
  /** Stable project key — the `project` column in git_events. */
  code: string;
  /** Absolute project path (repo root). */
  path: string;
}

export interface GitObserverDeps {
  /** Project enumeration — the config-loader registry in production. */
  listProjects: () => GitObserverProject[];
  /** DB for the default event sink. Ignored when `onEvent` is supplied. */
  db?: Db;
  /**
   * Transition sink override (test seam). When omitted and `db` is present, the
   * default sink inserts a `git_events` row. Return value is ignored.
   */
  onEvent?: (project: string, transition: GitTransition) => void;
  /**
   * Current-state map override (test seam). Defaults to the module-level
   * registry that `getObservedGitState` reads — production wiring.
   */
  state?: Map<string, GitStatusObject>;
  pollIntervalMs?: number;
  batchSize?: number;
  batchDelayMs?: number;
  perProjectTimeoutMs?: number;
}

export interface GitObserverHandle {
  stop(): void;
}

const delay = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => clearTimeout(t), { once: true });
  });

/**
 * Start the git observer: a self-rescheduling 60s poll over the registered
 * local projects, in staggered batches, persisting transitions and refreshing
 * the in-memory current-state map. `AbortController` tears down the poll timer
 * and inter-batch sleeps on `stop()`.
 */
export function startGitObserver(deps: GitObserverDeps): GitObserverHandle {
  const pollIntervalMs = deps.pollIntervalMs ?? POLL_INTERVAL_MS;
  const batchSize = deps.batchSize ?? BATCH_SIZE;
  const batchDelayMs = deps.batchDelayMs ?? BATCH_DELAY_MS;
  const timeoutMs = deps.perProjectTimeoutMs ?? PER_PROJECT_TIMEOUT_MS;
  const state = deps.state ?? observedState;
  const ac = new AbortController();

  const db = deps.db;
  const sink: (project: string, transition: GitTransition) => void =
    deps.onEvent ??
    (db
      ? (project, transition) => {
          void db
            .insert(gitEvents)
            .values({
              project,
              eventType: transition.eventType,
              fromRef: transition.fromRef,
              toRef: transition.toRef,
              sha: transition.sha,
            })
            .catch((err) => {
              log.warn({ project, err }, "git-observer: event insert failed");
            });
        }
      : () => {});

  async function observeProject(project: GitObserverProject): Promise<void> {
    const curr = await observeGitState(project.path, timeoutMs);
    if (curr === null) {
      log.debug(
        { project: project.code, path: project.path },
        "git-observer: skipped (missing / non-repo / timeout)",
      );
      return;
    }
    const prev = state.get(project.code);
    const transition = detectGitTransition(prev, curr);
    state.set(project.code, { ...curr, observedAt: new Date().toISOString() });
    if (transition) {
      try {
        sink(project.code, transition);
      } catch (err) {
        log.warn({ project: project.code, err }, "git-observer: sink threw");
      }
    }
  }

  async function tick(): Promise<void> {
    let projects: GitObserverProject[];
    try {
      projects = deps.listProjects();
    } catch (err) {
      log.warn({ err }, "git-observer: listProjects failed; skipping tick");
      return;
    }
    for (let i = 0; i < projects.length; i += batchSize) {
      if (ac.signal.aborted) return;
      const batch = projects.slice(i, i + batchSize);
      await Promise.all(batch.map((p) => observeProject(p)));
      if (i + batchSize < projects.length) await delay(batchDelayMs, ac.signal);
    }
  }

  async function schedule(): Promise<void> {
    if (ac.signal.aborted) return;
    try {
      await tick();
    } catch (err) {
      log.error({ err }, "git-observer: tick failed");
    }
    if (ac.signal.aborted) return;
    const timer = setTimeout(() => {
      void schedule();
    }, pollIntervalMs);
    ac.signal.addEventListener("abort", () => clearTimeout(timer), {
      once: true,
    });
  }

  void schedule();
  log.info({ pollIntervalMs, batchSize }, "git-observer started");

  return {
    stop() {
      ac.abort();
      log.info("git-observer stopped");
    },
  };
}
