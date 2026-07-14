/**
 * Cached bead sources (nx-veo5g.1 — Layer A of the crash-loop fix).
 *
 * The GET /specs, /specs/all, /roadmap, /beads/unlinked request path used to
 * spawn a live `bd` subprocess per project (roadmap: one `bd show` PER feature
 * bead) on every dashboard poll — the piled-up `bd`/`dolt` processes that
 * saturated the box and drove the crash loop (nx-6lrf7).
 *
 * This module is the ONE production bead source that reads from the
 * beads-watcher's in-memory parsed-bead cache instead. The watcher already
 * parses each project's `.beads/issues.jsonl` on every change / 60s poll; this
 * reads that cache, wired into the three existing DI seams
 * (`RollupBeadSource`, `RoadmapBeadSource`, and the unlinked route's source).
 *
 * Import direction is one-way: `beads-watcher` -> here -> consumers. This file
 * imports `getParsedBeads` from `beads-watcher`; `bead-rollup` /
 * `roadmap-aggregate` NEVER import this file (their default live-CLI sources
 * stay pure), so no circular import forms.
 *
 * Cold start (cache miss — project just registered, or the watcher hasn't
 * finished its first pass): fall back to exactly ONE live
 * `bd list --all --json` for the whole project, coalesced per project path via
 * single-flight so a roadmap request's `listEpics` + `listAll` + N `showSpecId`
 * calls (and concurrent requests) share one spawn instead of a spawn storm. On
 * live-call failure, degrade to `[]` (matches every consumer's existing
 * null/[] contract — never throws here).
 */

import { createLogger } from "@nexus/core/node";
import { getParsedBeads } from "./beads-watcher";
import type { RawBead, RollupBeadSource } from "./bead-rollup";
import type { RoadmapBeadSource } from "./roadmap-aggregate";
import { execJson } from "../utils/exec";
import { createSingleFlight } from "../utils/single-flight";

const log = createLogger("agent:services:cached-bead-source");

// Coalesce cold-start live `bd list --all` spawns per project path. Concurrent
// callers (roadmap's listEpics+listAll+N showSpecId, or overlapping requests)
// on the same cold project share ONE spawn instead of a duplicate-spawn storm.
const coldStartSingleFlight = createSingleFlight<RawBead[]>();

/**
 * Every bead for a project, cache-first.
 *
 *   - Cache hit (warm): returns the watcher's parsed array — ZERO subprocess.
 *   - Cache miss (cold start): exactly ONE `bd list --all --json`, coalesced
 *     per `cwd` via single-flight. On failure returns `[]` (degrade contract).
 */
export async function getBeadsForProject(cwd: string): Promise<RawBead[]> {
  const cached = getParsedBeads(cwd);
  if (cached !== undefined) return cached;

  return coldStartSingleFlight(cwd, async () => {
    try {
      // Single live spawn — `--all` so closed beads are included (parity with
      // the parsed-JSONL cache, which is a full dump). This is the only place
      // the cached sources ever shell to `bd`.
      const beads = await execJson<RawBead[]>(
        "bd",
        ["list", "--all", "--json"],
        { cwd },
      );
      return Array.isArray(beads) ? beads : [];
    } catch (err) {
      log.warn({ cwd, err }, "cached-bead-source: cold-start bd list failed; []");
      return [];
    }
  });
}

/**
 * Production {@link RollupBeadSource} — `listBeads` filters the cached full set
 * down to the requested ids (the batched-by-project rollup contract, with no
 * subprocess on a warm cache).
 */
export const cachedRollupBeadSource: RollupBeadSource = {
  async listBeads(ids, cwd) {
    if (ids.length === 0) return [];
    const idSet = new Set(ids);
    const all = await getBeadsForProject(cwd);
    return all.filter((b) => idSet.has(b.id));
  },
};

/**
 * Production {@link RoadmapBeadSource} — spreads the cached rollup source for
 * `listBeads`, and derives `listEpics` / `listAll` / `showSpecId` from the same
 * cached full set (mirrors how `defaultRoadmapBeadSource` spreads
 * `defaultRollupBeadSource`). `spec_id` is present in the JSONL export today,
 * so `showSpecId` needs no `bd show` spawn.
 */
export const cachedRoadmapBeadSource: RoadmapBeadSource = {
  ...cachedRollupBeadSource,
  async listEpics(cwd) {
    const all = await getBeadsForProject(cwd);
    return all.filter((b) => b.issue_type === "epic");
  },
  listAll(cwd) {
    return getBeadsForProject(cwd);
  },
  async showSpecId(featureId, cwd) {
    const all = await getBeadsForProject(cwd);
    return all.find((b) => b.id === featureId)?.spec_id ?? null;
  },
};

/**
 * Source shape for {@link computeUnlinkedForProject}'s DI seam — lists the
 * open + in_progress beads a project has, from which the route derives the
 * unlinked subset.
 */
export interface UnlinkedBeadSource {
  listOpenBeads(cwd: string): Promise<RawBead[]>;
}

/**
 * Production unlinked source — filters the cached full set to open/in_progress
 * client-side (the cache holds all statuses), replacing the old live
 * `bd list --status open,in_progress --json` spawn.
 */
export const cachedUnlinkedBeadSource: UnlinkedBeadSource = {
  async listOpenBeads(cwd) {
    const all = await getBeadsForProject(cwd);
    return all.filter((b) => b.status === "open" || b.status === "in_progress");
  },
};
