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
}
