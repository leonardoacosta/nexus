<!-- beads:epic:nx-cou57 -->
<!-- beads:feature:nx-798fg -->

# Implementation Tasks

## E2E Batch

- [x] [4.1] Insert 2 poll-interval vars (`NEXUS_TAILSCALE_POLL_MS`, `NEXUS_USAGE_POLL_INTERVAL_MS`) beside `HEALTH_PUSH_INTERVAL_MS`, and append 4 retention-day vars (`SPEC_SNAPSHOTS_RETENTION_DAYS`, `PROJECT_STATUS_SNAPSHOTS_RETENTION_DAYS`, `GIT_EVENTS_RETENTION_DAYS`, `CREDENTIALS_RETENTION_DAYS` as its own conditional-scope block) to `.env.example`, per plans/036-env-example-doc-drift-wave4.md Steps 2-3; verify `audit-scan` H1 count goes 16->10 [owner:docs-engineer] [type:docs] [beads:nx-o6zs9]
- [x] [4.2] Add a second, path-scoped A2 suppression stanza to `.audit-suppressions.json` covering `apps/agent/src/services/process-watcher.test.ts`, `apps/agent/src/services/process-watcher.integration.test.ts`, `apps/agent/src/routes/health-process-watcher.test.ts`, per plans/037-narrow-a2-suppression-test-skip-diagnostics.md Step 1; do NOT add A2 to autoSkipTestFiles [owner:docs-engineer] [type:config] [beads:nx-ax70n]
- [x] [4.3] Verify `bash scripts/validate-audit-suppressions.sh` exits 0 (19 entries) and `bun test packages/core/src/audit-suppressions.integration.test.ts -t "A2 finding count is zero"` flips from FAIL to `1 pass` [owner:e2e-engineer] [type:testing] [beads:nx-xno0g]
