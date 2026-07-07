/**
 * Roadmap wire types — what `GET /roadmap` returns.
 *
 * The runtime aggregator lives in
 * `apps/agent/src/services/roadmap-aggregate.ts`; this file pins the
 * canonical wire shape so the Swift `RoadmapCapability` decoder has a
 * stable contract on both sides of the boundary.
 *
 * Added by `add-bead-proposal-roadmap-surface`.
 */

import type { BeadRollup } from "./spec";

/** One proposal listed under a capability, with its live bead rollup. */
export interface RoadmapProposal {
  /** OpenSpec proposal slug (the feature bead's `spec_id`). */
  slug: string;
  rollup: BeadRollup;
  /** `active` (live proposal), `archived`, or `missing`. */
  specStatus: string;
}

/**
 * A `[CAPABILITY]` epic with its child proposals and aggregate progress.
 *
 * `progress` sums task counts across all proposals under the capability so
 * the dashboard can render a capability-level bar independent of the
 * per-proposal bars.
 */
export interface RoadmapCapability {
  /** Capability name, i.e. the epic title minus the `[CAPABILITY] ` prefix. */
  name: string;
  epicId: string;
  epicStatus: string;
  proposals: RoadmapProposal[];
  progress: {
    totalTasks: number;
    closedTasks: number;
  };
}
