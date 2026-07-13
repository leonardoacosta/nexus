<!-- beads:epic:nx-0bhyl -->
<!-- beads:feature:nx-47k7r -->

# Implementation Tasks

## DB Batch

- [x] [1.1] [P-1] Add `packages/db/src/schema/specSnapshots.ts` + `packages/db/src/schema/projectStatusSnapshots.ts` (identity pk, `project` text, counts, `created_at`; header comments citing this spec + retention window, mirroring `specSessions.ts`'s conventions) and export both from `packages/db/src/schema/index.ts`. Generate the migration via `pnpm --filter @nexus/db db:generate` and commit the `.sql` file — migration-based only, never `db:push`. [owner:db-engineer] [type:db] [beads:nx-t8fi4]
- [x] [1.2] [P-2] Extend `apps/agent/src/db/retention.ts` with 90d env-overridable cutoffs + deletes + log fields for `spec_snapshots` and `project_status_snapshots` (one cutoff const + one delete each, matching the `cron_runs` shape). [owner:db-engineer] [type:db] [beads:nx-2fuos]

## API Batch

- [x] [2.1] [P-1] Add `packages/core/src/types/project-status.ts` — Zod schemas for the GET /projects/:id/status response (latest + history variants) and the BeadTransition payload; export from `packages/core/src/index.ts`, mirroring `types/session-context.ts`'s one-contract-file-per-capability convention. [owner:types-engineer] [type:api] [beads:nx-4c0ig]
- [x] [2.2] [P-2] Add `apps/agent/src/services/beads-watcher.ts` — per-project watch on the `.beads/` parent dir filtered to `issues.jsonl` (atomic rename-over safe), 300ms debounce, unconditional 60s poll fallback, AbortController teardown, JSONL parse with fail-open on malformed reads; unlinked ready/blocked derivation reusing `services/bead-rollup.ts`'s marker parsing (see design.md § Counting from JSONL and specs/spec-watcher delta). Zero `bd` CLI calls. [owner:api-engineer] [type:api] [beads:nx-ol4vs]
- [x] [2.3] [P-2] Add `BeadTransitionPayload` + `LifecycleEventMap` entry to `apps/agent/src/services/lifecycle-bus.ts` (fields per specs/spec-watcher delta), confirming the existing SSE endpoint forwards it. [owner:api-engineer] [type:api] [beads:nx-ews3y]
- [x] [2.4] [P-3] Add `apps/agent/src/services/status-snapshots.ts` — change-only snapshot writer comparing recomputed totals against the latest persisted row (per-spec `spec_snapshots` + per-project `project_status_snapshots`), emitting BeadTransition only on bead-count change; wire it into the spec-watcher tick/refresh path (`services/spec-watcher/index.ts`) and the beads-watcher recount callback. [owner:api-engineer] [type:api] [beads:nx-tegez]
- [x] [2.5] [P-4] Add `apps/agent/src/routes/project-status.ts` — GET /projects/:id/status (200 latest / 404 unknown) + `?history=<days>` capped at retention, ordered oldest-first; register via the `tryHandle*` delegation + `LEGACY_DISPATCH_ROUTES` entry in `apps/agent/src/server-request-handler.ts`, same pattern as the session-context routes. [owner:api-engineer] [type:api] [beads:nx-cw87n]

## UI Batch

- [x] [3.1] Add minimal `BeadTransition` decode to NexusShared — Codable model in `apps/swift/NexusShared/Models` + SSE observer wiring in `apps/swift/NexusShared/Observers`, following the existing SpecTransition decode shape; no new dashboard surface in this change. [owner:swift-engineer] [type:ui] [beads:nx-wtyz8]

## E2E Batch

- [x] [4.1] Unit tests for beads-watcher + derivation: rename-over rewrite triggers exactly one recount (debounce), poll fallback fires without fs events, missing `.beads/` skips cleanly, malformed JSONL keeps previous counts, and the parity fixture where the live beads-unlinked derivation and the JSONL recount report identical ready/blocked-unlinked totals (specs/bead-proposal-roadmap delta); BeadTransition emitted once on change, silent on no-change. [owner:tdd-integration] [type:testing] [beads:nx-kwea5]
- [x] [4.2] Unit + PG-gated tests for snapshot writer and routes: change-only insert semantics for both tables, restart-compare-against-latest-row, GET latest/history/404, history capped at retention window, and retention prune deletes aged rows from both tables. [owner:tdd-integration] [type:testing] [beads:nx-vtmmm]
