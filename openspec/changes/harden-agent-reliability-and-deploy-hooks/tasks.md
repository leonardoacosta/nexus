<!-- beads:epic:nx-veo5g -->
<!-- beads:feature:nx-ujthz -->

# Implementation Tasks

## API Batch

- [x] [2.1] Add structured WARN-level memory-pressure logging to the agent process when usage crosses 90% of `MemoryMax`, giving future SIGABRT/SIGILL investigations a diagnostic trail (nx-t9wlb) [owner:api-engineer] [type:infra] [beads:nx-ej4nb]
- [x] [2.2] Fix `server-health-handler.ts:202-215` to import and call the shared `aggregateDiskPercent()` helper instead of re-implementing the stale `metrics.disk[0]?.percent ?? null` fallback (nx-4l1zt) [owner:api-engineer] [type:api] [beads:nx-1l69v]
- [x] [2.3] Fix `deploy/hooks.d/post-merge/02-deploy` to detect a `bun install --frozen-lockfile` failure and either regenerate the lockfile safely or surface an actionable recovery signal (nx-zpbqi) [owner:devops-engineer] [type:ci-cd] [beads:nx-qbdcn]
- [x] [2.4] Fix `deploy/hooks.d/post-merge/03-migrate` to detect a non-primary DB-writing machine and skip `db:migrate` entirely, rather than failing on a missing local `POSTGRES_URL` (nx-9k141) [owner:devops-engineer] [type:ci-cd] [beads:nx-30r5e]

## UI Batch

- [ ] [3.1] Fix the Mac dashboard PTY viewer's attach-handshake race: buffer bytes arriving before the initial `resize(cols, rows)` frame and flush them in order once geometry is applied (nx-f1l69) [owner:swift-engineer] [type:ui] [beads:nx-awuz5]

## E2E Batch

- [ ] [4.1] Verify structured memory-pressure log line appears under simulated high-memory load [owner:e2e-engineer] [type:testing] [beads:nx-1cjk5]
- [ ] [4.2] Scripted attach-then-immediately-write repro against the fixed PtyViewer, confirm no garbled output [owner:e2e-engineer] [type:testing] [beads:nx-du86t]
- [ ] [4.3] Unit test: `server-health-handler.ts`'s multi-disk aggregation matches `health-scheduler.ts`'s output for the all-zero-total_bytes case [owner:tdd-integration] [type:testing] [beads:nx-35qsf]
- [ ] [4.4] Fix `apps/agent/src/services/reaper-persistence.test.ts`'s shared-schema `beforeAll` leak with per-test cleanup; confirm pass regardless of declaration order (nx-gwnpb) [owner:tdd-implementer] [type:testing] [beads:nx-1cty9]
- [ ] [4.5] Fix the `mock.module` leakage causing PG-gated cross-contamination under `NEXUS_HEAVY_TESTS=1 NEXUS_PG_TESTS=1`; confirm the 17 previously-failing tests pass identically standalone and in the full suite (nx-rzaej) [owner:tdd-implementer] [type:testing] [beads:nx-06o3m]
- [ ] [4.6] Simulate a frozen-install lockfile-drift failure against the fixed 02-deploy hook, confirm recovery or actionable-alert behavior [owner:e2e-engineer] [type:testing] [beads:nx-ma1aq]
- [ ] [4.7] Unit test: 03-migrate hook exits early on a non-primary-flagged machine even with a `packages/db/` schema change present [owner:e2e-engineer] [type:testing] [beads:nx-h0gnb]
