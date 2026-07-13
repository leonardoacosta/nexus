/**
 * Zod schemas for the git-observation surface of the project status API:
 *   - the `git` object folded into `GET /projects/:id/status` (the observer's
 *     in-memory current state — branch, HEAD sha, detached flag, dirty counts,
 *     observedAt), and
 *   - the `GET /projects/:id/git-events?days=<n>` history response (append-only
 *     transitions from the Postgres `git_events` table).
 *
 * Shared between the agent (`apps/agent/src/services/git-observer.ts`,
 * `apps/agent/src/routes/project-status.ts`) and any client decoding either
 * response so the wire shape stays single-sourced. Backs the Postgres
 * `git_events` table (`packages/db/src/schema/gitEvents.ts`) — field names are
 * the camelCase wire form of that table's snake_case columns.
 *
 * Spec: openspec/changes/add-git-status-orbit/ (git-event-store delta).
 */

import { z } from "zod";

/**
 * Dirty working-tree counts from `git status --porcelain`: tracked
 * modifications and untracked files, kept separate so a client can render "N
 * changed, M new" without re-shelling out. Non-negative integers.
 */
export const gitDirtyCounts = z.object({
  modified: z.number().int().nonnegative(),
  untracked: z.number().int().nonnegative(),
});
export type GitDirtyCounts = z.infer<typeof gitDirtyCounts>;

/**
 * The observer's in-memory current git state for a project, folded into the
 * `GET /projects/:id/status` response as the `git` field (omitted entirely
 * when the project has not been observed on this agent).
 *
 * `branch` is `null` on a detached HEAD (`detached` is then `true`); the two
 * are kept as distinct fields so the detached case is explicit rather than
 * inferred from a null branch. `observedAt` is ISO 8601 — the poll time the
 * state was last refreshed, so a client can tell fresh state from stale.
 */
export const gitStatusObject = z.object({
  branch: z.string().nullable(),
  headSha: z.string(),
  detached: z.boolean(),
  dirty: gitDirtyCounts,
  observedAt: z.string(),
});
export type GitStatusObject = z.infer<typeof gitStatusObject>;

/**
 * One `git_events` row on the wire. `eventType` is kept as a bare string (not
 * a Zod enum) to mirror the `git_events.event_type` text column's deliberate
 * extensibility — a future transition kind lands without a schema/contract
 * change. Known values today:
 *   - "branch_switch" — HEAD moved to a different branch (fromRef -> toRef)
 *   - "new_commit"    — same branch, new HEAD sha (sha = new HEAD)
 *   - "detached_head" — HEAD points at a bare sha (sha = detached HEAD)
 *
 * `fromRef` / `toRef` / `sha` are all nullable because which are populated
 * depends on the event type. `createdAt` is ISO 8601 (`timestamptz` -> JSON).
 */
export const gitEventRecord = z.object({
  eventType: z.string(),
  fromRef: z.string().nullable(),
  toRef: z.string().nullable(),
  sha: z.string().nullable(),
  createdAt: z.string(),
});
export type GitEventRecord = z.infer<typeof gitEventRecord>;

/**
 * GET /projects/:id/git-events?days=<n> response — the persisted transition
 * history within the (retention-capped) window, ordered oldest-first by
 * `createdAt`. Returns `[]` when there are none.
 */
export const gitEventsResponse = z.array(gitEventRecord);
export type GitEventsResponse = z.infer<typeof gitEventsResponse>;
