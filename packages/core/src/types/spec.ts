/**
 * Spec wire types — what `GET /specs` returns.
 *
 * The runtime spec snapshot lives in `apps/agent/src/services/spec-watcher/parser.ts`
 * (`SpecSnapshot`); this file pins the canonical wire shape so the Swift
 * `SpecSummary` decoder (PayloadDecodeTests v2) has a stable contract on
 * both sides of the boundary.
 *
 * Added by `agent-payload-completeness` — closes the
 * `/specs` lacks marker tri-state gap.
 */

/** A single spec row as emitted by `GET /specs`. */
export interface SpecSummary {
  name: string;
  status: string;
  /** Project code (e.g. `nx`, `oo`) — added by the route handler. */
  project: string;
  completedTasks: number;
  totalTasks: number;
  lastModified?: string;
  /**
   * Marker tri-state booleans — true iff the corresponding markdown
   * artifact exists in the spec directory at scan time. All three are
   * non-optional in current-generation agent emissions; the Swift decoder
   * defaults to `false` on older agents that omit any of them.
   */
  has_proposal: boolean;
  has_design: boolean;
  has_tasks: boolean;
  /**
   * Live bead rollup for this proposal, or `null` when `bd` is unavailable
   * or the project has no `.beads/` directory. Attached by
   * `add-bead-proposal-roadmap-surface`.
   */
  beadRollup?: BeadRollup | null;
}

/**
 * A single linked bead, as surfaced in a {@link BeadRollup}.
 *
 * Wire shape for the bead <-> proposal <-> roadmap surface
 * (`add-bead-proposal-roadmap-surface`). `type` mirrors bd's `issue_type`
 * field (epic | feature | task | bug | chore).
 */
export interface BeadRef {
  id: string;
  status: string;
  type: string;
  priority: number;
  title: string;
}

/**
 * Per-proposal bead rollup computed live from the `beads:epic` /
 * `beads:feature` / `[beads:<id>]` markers in the proposal's `tasks.md`.
 *
 * `tasks` counts task beads ONLY (epic + feature excluded), so a 14-task
 * proposal reads `x/14` — matching `bd epic status`. `beads` carries the
 * full linked set (epic + feature + tasks) for the detail view.
 */
export interface BeadRollup {
  epic: BeadRef | null;
  feature: BeadRef | null;
  tasks: {
    total: number;
    closed: number;
    ready: number;
    blocked: number;
  };
  beads: BeadRef[];
}

/**
 * An open (or in_progress) bead not referenced by any live proposal's
 * `tasks.md` — unplanned work surfaced by `GET /beads/unlinked`.
 */
export interface UnlinkedBead {
  id: string;
  title: string;
  status: string;
  priority: number;
  type: string;
}
