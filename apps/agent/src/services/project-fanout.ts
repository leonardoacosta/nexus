/**
 * Shared `project=all` fan-out helper (refocus-board-shell 2.3/2.4).
 *
 * Both `GET /roadmap?project=all` and `GET /beads/unlinked?project=all` need
 * the same shape: resolve the fleet project list minus user-hidden projects,
 * fan a per-project computation out concurrently, exclude (warn-log) any
 * project whose computation throws, and tag each surviving entry with its
 * source project `code`. This module owns that machinery so neither route
 * duplicates it.
 *
 * Project population: `getProjects()` (the static cc-fleet config in
 * `projects.json`) is the ONLY source carrying filesystem `path`s, which the
 * per-project bd/openspec scans require. The DB `projects.hidden` sticky-
 * exclude flag lives in a SEPARATE registry (auto-discovered session
 * projects); we cross-reference it by absolute path so a project the user has
 * hidden from the dashboard contributes nothing to the `all` view. A project
 * with no registry row (never had a live session) is treated as visible.
 * When `db` is absent the hidden filter is a no-op (all projects visible).
 */

import type { Db } from "@nexus/db";
import { createLogger } from "@nexus/core/node";
import { getProjects } from "./config-loader";
import { listAllRegisteredProjects } from "../db/project-registry";
import { runPool } from "../utils/run-pool";

/**
 * Bounded fan-out concurrency for `project=all`. Matches `SPECS_ALL_CONCURRENCY`
 * in `routes/specs.ts` — each project's `compute` shells out to bd/openspec, so
 * a bare `Promise.allSettled` over all ~36 projects would spawn a subprocess
 * storm in one tick (the nx-6lrf7 memory-exhaustion burst). 8 keeps throughput
 * high while the exec-layer global budget bounds actual concurrent spawns.
 */
export const FANOUT_ALL_CONCURRENCY = Number(
  process.env.FANOUT_ALL_CONCURRENCY ?? 8,
);

/** A resolved fan-out target: project code + absolute filesystem path. */
export interface FanOutProject {
  code: string;
  path: string;
}

/** Test seams for `resolveAllProjects` — default to the live sources. */
export interface ResolveProjectsDeps {
  listProjects?: () => Array<{ code: string; path: string }>;
  listHidden?: (db: Db) => Promise<Array<{ path: string; hidden: boolean }>>;
}

/** Minimal logger surface used by the fan-out (pino `warn`). */
type FanOutLogger = Pick<ReturnType<typeof createLogger>, "warn">;

/** Strip trailing slashes so registry/config path comparison is stable. */
function normalizePath(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

/**
 * Resolve the `project=all` fan-out list: every `getProjects()` entry whose
 * absolute path is NOT marked `hidden` in the DB registry. Registry read
 * failures degrade to "nothing hidden" (never throws). Without a `db` handle
 * the hidden filter is skipped entirely.
 */
export async function resolveAllProjects(
  db?: Db,
  deps: ResolveProjectsDeps = {},
): Promise<FanOutProject[]> {
  const listProjects = deps.listProjects ?? getProjects;
  const listHidden = deps.listHidden ?? listAllRegisteredProjects;

  const all = listProjects().map((p) => ({ code: p.code, path: p.path }));
  if (!db) return all;

  let hiddenPaths = new Set<string>();
  try {
    const registered = await listHidden(db);
    hiddenPaths = new Set(
      registered.filter((r) => r.hidden).map((r) => normalizePath(r.path)),
    );
  } catch {
    // listAllRegisteredProjects already fails soft; this is defense in depth.
    hiddenPaths = new Set();
  }

  return all.filter((p) => !hiddenPaths.has(normalizePath(p.path)));
}

/**
 * Fan `compute` out concurrently across `projects`, tag each produced entry
 * with its project code via `tag`, and merge. A project whose `compute`
 * rejects is excluded and logged at warn level — never propagated (the route
 * still returns HTTP 200 with the surviving projects). Never throws.
 */
export async function fanOutAllProjects<T>(
  projects: FanOutProject[],
  compute: (path: string) => Promise<T[]>,
  tag: (entry: T, code: string) => T,
  log: FanOutLogger,
  concurrency: number = FANOUT_ALL_CONCURRENCY,
): Promise<T[]> {
  // runPool caps how many `compute` closures are live at once (the fix for the
  // unbounded fan-out). The per-project try/catch keeps the degrade contract:
  // runPool propagates a worker rejection, so a project whose compute throws is
  // isolated HERE (warn-log + contribute []) rather than aborting the batch.
  const perProject = await runPool(projects, concurrency, async (proj) => {
    try {
      const entries = await compute(proj.path);
      return entries.map((entry) => tag(entry, proj.code));
    } catch (err) {
      log.warn(
        { project: proj.code, err },
        "project excluded from project=all fan-out",
      );
      return [] as T[];
    }
  });

  return perProject.flat();
}
