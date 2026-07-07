/**
 * Capability roadmap aggregation (add-bead-proposal-roadmap-surface).
 *
 * Enumerates `[CAPABILITY]` epics, maps each child feature bead to its
 * proposal via the feature bead's `spec_id` (the ONE place `spec_id` is
 * read — it is the feature-bead -> proposal-slug edge that lives nowhere
 * else), reuses `computeBeadRollup` per proposal, and rolls task progress
 * up per capability.
 *
 * `spec_id` is read via `bd show <feature> --json` (only `bd show` surfaces
 * it). Bounded: one `bd show` per feature bead — feature beads per
 * capability are few.
 *
 * Every bd interaction is degradable: on any failure the result is `[]`
 * (never thrown), so `GET /roadmap` returns `{ capabilities: [] }` rather
 * than a 500.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { RoadmapCapability, RoadmapProposal } from "@nexus/core";
import {
  computeBeadRollup,
  defaultRollupBeadSource,
  emptyRollup,
  type RawBead,
  type RollupBeadSource,
} from "./bead-rollup";
import { execJson } from "../utils/exec";

const CAPABILITY_PREFIX = "[CAPABILITY] ";

// ---------------------------------------------------------------------------
// Bead source (DI seam — extends the rollup source with roadmap ops)
// ---------------------------------------------------------------------------

export interface RoadmapBeadSource extends RollupBeadSource {
  /** All epics (`bd list --type epic --json`). */
  listEpics(cwd: string): Promise<RawBead[]>;
  /** Every bead (`bd list --json`) — used to resolve children by `parent`. */
  listAll(cwd: string): Promise<RawBead[]>;
  /** A feature bead's `spec_id` (`bd show <id> --json` -> element 0). */
  showSpecId(featureId: string, cwd: string): Promise<string | null>;
}

export const defaultRoadmapBeadSource: RoadmapBeadSource = {
  ...defaultRollupBeadSource,
  listEpics(cwd) {
    return execJson<RawBead[]>("bd", ["list", "--type", "epic", "--json"], {
      cwd,
    });
  },
  listAll(cwd) {
    return execJson<RawBead[]>("bd", ["list", "--json"], { cwd });
  },
  async showSpecId(featureId, cwd) {
    const arr = await execJson<RawBead[]>("bd", ["show", featureId, "--json"], {
      cwd,
    });
    return (Array.isArray(arr) ? arr[0]?.spec_id : undefined) ?? null;
  },
};

// ---------------------------------------------------------------------------
// specStatus classification (pure-ish; only touches the filesystem)
// ---------------------------------------------------------------------------

/**
 * Classify a proposal slug as `active` (a live change dir exists),
 * `archived` (only an archive entry exists), or `missing` (neither). This
 * keeps a feature bead pointing at an archived proposal classified — not
 * dropped.
 */
export function classifySpecStatus(
  projectPath: string,
  slug: string,
): "active" | "archived" | "missing" {
  const liveDir = join(projectPath, "openspec", "changes", slug);
  if (existsSync(liveDir)) return "active";

  const archiveRoot = join(projectPath, "openspec", "changes", "archive");
  if (existsSync(archiveRoot)) {
    try {
      const suffix = `-${slug}`;
      for (const entry of readdirSync(archiveRoot)) {
        if (entry === slug || entry.endsWith(suffix)) return "archived";
      }
    } catch {
      /* fall through */
    }
  }
  return "missing";
}

// ---------------------------------------------------------------------------
// computeRoadmap — IO orchestrator
// ---------------------------------------------------------------------------

/**
 * Build the capability roadmap for a project. Returns `[]` when the project
 * has no `.beads/` directory or `bd` errors.
 */
export async function computeRoadmap(
  projectPath: string,
  source: RoadmapBeadSource = defaultRoadmapBeadSource,
): Promise<RoadmapCapability[]> {
  if (!existsSync(join(projectPath, ".beads"))) return [];

  let epics: RawBead[];
  let all: RawBead[];
  try {
    [epics, all] = await Promise.all([
      source.listEpics(projectPath),
      source.listAll(projectPath),
    ]);
  } catch {
    return [];
  }

  const capabilityEpics = (Array.isArray(epics) ? epics : []).filter((e) =>
    (e.title ?? "").startsWith(CAPABILITY_PREFIX),
  );
  const allBeads = Array.isArray(all) ? all : [];

  const capabilities: RoadmapCapability[] = [];

  for (const epic of capabilityEpics) {
    const name = (epic.title ?? "").slice(CAPABILITY_PREFIX.length);
    const featureBeads = allBeads.filter(
      (b) => b.parent === epic.id && b.issue_type === "feature",
    );

    const proposals: RoadmapProposal[] = [];
    let totalTasks = 0;
    let closedTasks = 0;

    for (const feature of featureBeads) {
      let slug: string | null;
      try {
        slug = await source.showSpecId(feature.id, projectPath);
      } catch {
        slug = null;
      }
      if (!slug) continue;

      const rollup =
        (await computeBeadRollup(projectPath, slug, source)) ?? emptyRollup();
      const specStatus = classifySpecStatus(projectPath, slug);

      proposals.push({ slug, rollup, specStatus });
      totalTasks += rollup.tasks.total;
      closedTasks += rollup.tasks.closed;
    }

    capabilities.push({
      name,
      epicId: epic.id,
      epicStatus: epic.status ?? "unknown",
      proposals,
      progress: { totalTasks, closedTasks },
    });
  }

  return capabilities;
}
