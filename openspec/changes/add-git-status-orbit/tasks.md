<!-- beads:epic:nx-dkwmk -->
<!-- beads:feature:nx-23rz3 -->

# Implementation Tasks

## DB Batch

- [ ] [1.1] [P-1] Add `packages/db/src/schema/gitEvents.ts` (identity pk, `project` text, `event_type` text, `from_ref`/`to_ref`/`sha` nullable text, `created_at`; header comment citing this spec + retention window, mirroring `specSessions.ts`'s conventions) and export from `packages/db/src/schema/index.ts`. Generate the migration via `pnpm --filter @nexus/db db:generate` and commit the `.sql` file — migration-based only, never `db:push`. [owner:db-engineer] [type:db] [beads:nx-zi4mm]
- [ ] [1.2] [P-2] Extend `apps/agent/src/db/retention.ts` with a 90d env-overridable cutoff + delete + log field for `git_events` (one cutoff const + one delete, matching the `cron_runs` shape). [owner:db-engineer] [type:db] [beads:nx-qq6yh]

## API Batch

- [ ] [2.1] [P-1] Add `packages/core/src/types/git-status.ts` — Zod schemas for the status payload's `git` object and the GET /projects/:id/git-events response; export from `packages/core/src/index.ts`, following the one-contract-file-per-capability convention. [owner:types-engineer] [type:api] [beads:nx-zxhvy]
- [ ] [2.2] [P-2] Add `apps/agent/src/services/git-observer.ts` — 60s staggered poll over locally-present registered project locations, per-project timeout + fail-open skip, first-observation baseline, transition detection inserting `git_events` rows, in-memory current-state map, AbortController teardown; wire startup in `apps/agent/src/index.ts`. Exact plumbing reads, batching shape, and semantics per design.md § Poll-only observation and the specs/git-event-store delta. [owner:api-engineer] [type:api] [beads:nx-3gsaj]
- [ ] [2.3] [P-3] Extend `apps/agent/src/routes/project-status.ts` (landed by `add-project-status-snapshots`) — fold the observer's current-state `git` object into the GET /projects/:id/status response (omitted when unobserved) and add GET /projects/:id/git-events?days= (capped at retention, oldest first, 404 unknown project); register the git-events dispatch via the existing `tryHandle*` delegation in `apps/agent/src/server-request-handler.ts`. [owner:api-engineer] [type:api] [beads:nx-o6n4m]

## E2E Batch

- [ ] [4.1] Unit tests for git-observer: baseline-then-transition detection for branch_switch/new_commit/detached_head against a temp-repo fixture, first observation emits no events, non-repo/missing location fail-open with others unaffected, per-project timeout abandonment, staggered batch bounds. [owner:tdd-integration] [type:testing] [beads:nx-p3uqv]
- [ ] [4.2] Unit + PG-gated tests for serving and retention: status payload includes `git` object when observed and omits it when not, git-events history days window + oldest-first ordering + 404 unknown project, retention prune deletes aged git_events rows. [owner:tdd-integration] [type:testing] [beads:nx-v4axa]
