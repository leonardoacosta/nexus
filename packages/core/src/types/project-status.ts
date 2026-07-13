/**
 * Zod schemas for the per-project status-snapshot API and the BeadTransition
 * lifecycle-bus event.
 *
 * Shared between the agent (`apps/agent/src/routes/project-status.ts`,
 * `apps/agent/src/server-request-handler.ts`,
 * `apps/agent/src/services/status-snapshots.ts`,
 * `apps/agent/src/services/lifecycle-bus.ts`) and any client that decodes the
 * `GET /projects/:id/status` response so the wire shape stays single-sourced.
 * Backs the Postgres `project_status_snapshots` time-series table
 * (`packages/db/src/schema/projectStatusSnapshots.ts`) — field names are the
 * camelCase wire form of that table's snake_case columns.
 *
 * Spec: openspec/changes/add-project-status-snapshots/
 */

import { z } from "zod";

/**
 * A single `project_status_snapshots` row on the wire. Mirrors the DB columns
 * (`proposals_unarchived`, `beads_ready_unlinked`, `beads_blocked_unlinked`,
 * `created_at`) in camelCase. Counts are non-negative integers; `createdAt` is
 * ISO 8601 (Postgres `timestamptz` serialized to JSON).
 */
export const projectStatusSnapshot = z.object({
  project: z.string(),
  proposalsUnarchived: z.number().int().nonnegative(),
  beadsReadyUnlinked: z.number().int().nonnegative(),
  beadsBlockedUnlinked: z.number().int().nonnegative(),
  createdAt: z.string(),
});
export type ProjectStatusSnapshot = z.infer<typeof projectStatusSnapshot>;

/**
 * GET /projects/:id/status response — the "latest" shape (no `?history`): the
 * single most-recent snapshot for the project.
 */
export const projectStatusLatestResponse = projectStatusSnapshot;
export type ProjectStatusLatestResponse = z.infer<
  typeof projectStatusLatestResponse
>;

/**
 * GET /projects/:id/status?history=<days> response — the time series: snapshots
 * within the window, ordered oldest-first by `createdAt`.
 */
export const projectStatusHistoryResponse = z.array(projectStatusSnapshot);
export type ProjectStatusHistoryResponse = z.infer<
  typeof projectStatusHistoryResponse
>;

/**
 * The unlinked ready/blocked bead counts carried by a BeadTransition. Named to
 * match the `project_status_snapshots` columns they derive from.
 */
export const beadUnlinkedCounts = z.object({
  beadsReadyUnlinked: z.number().int().nonnegative(),
  beadsBlockedUnlinked: z.number().int().nonnegative(),
});
export type BeadUnlinkedCounts = z.infer<typeof beadUnlinkedCounts>;

/**
 * BeadTransition lifecycle-bus payload — emitted only when a project's unlinked
 * ready/blocked bead counts change (the change-only snapshot comparison doubles
 * as the emission gate). Symmetric with `SpecTransitionProgressEvent`: carries
 * the project, the counts before and after the change, and the change time
 * (`at`, ISO 8601). Exposed on the existing lifecycle SSE stream.
 */
export const beadTransitionPayload = z.object({
  project: z.string(),
  previous: beadUnlinkedCounts,
  current: beadUnlinkedCounts,
  at: z.string(),
});
export type BeadTransitionPayload = z.infer<typeof beadTransitionPayload>;
