---
status: draft
---

# Proposal: Close env-doc-hygiene and audit-suppression drift (plans 036 + 037)

## Change ID
`close-env-doc-and-audit-suppression-drift`

## Summary
Bundles two small, already-fully-planned hygiene follow-ups from the 2026-07-13 `/improve`
audit into one openspec change: document 6 operator-facing env vars missing from
`.env.example`, and add a narrow A2 (console.log) suppression entry for 4 guarded
test-skip-reason diagnostic sites, fixing a currently-red regression test.

## Context
- Related: `plans/036-env-example-doc-drift-wave4.md`, `plans/037-narrow-a2-suppression-test-skip-diagnostics.md` — both fully detailed executor plans, converted here into tracked openspec batches rather than re-derived.
- touches: `.env.example`, `.audit-suppressions.json`

## Motivation
Both items were found by the same noise/drift audit and are pure documentation/config
corrections with zero behavior change to shipped code:

1. Six real, currently-read env vars (4 retention-day knobs + 2 poll intervals) have no
   `.env.example` entry, so an operator cannot discover they exist without reading source.
   `audit-scan`'s H1 check currently reports 16 undocumented vars; 6 belong to this gap.
2. Four `console.log` sites exist specifically to print test-skip-reason diagnostics
   (Postgres/tmux-gated test blocks), each already guarded by
   `// eslint-disable-next-line no-console` — but A2 is the only debug/logging check ID with
   no auto-skip for test files, so these 4 sites resurface as false-positive findings on every
   `audit-scan` run. A committed regression test
   (`packages/core/src/audit-suppressions.integration.test.ts`, "A2 finding count is zero on
   the nx repo") is currently RED because of this exact gap.

## Requirements

### Requirement: env-doc-hygiene — retention-day and poll-interval vars documented
`.env.example` MUST carry entries for `CREDENTIALS_RETENTION_DAYS`,
`GIT_EVENTS_RETENTION_DAYS`, `PROJECT_STATUS_SNAPSHOTS_RETENTION_DAYS`,
`SPEC_SNAPSHOTS_RETENTION_DAYS` (appended to the existing retention block, plus a standalone
block for `CREDENTIALS_RETENTION_DAYS` describing its conditional delete predicate), and
`NEXUS_TAILSCALE_POLL_MS` / `NEXUS_USAGE_POLL_INTERVAL_MS` (inserted beside
`HEALTH_PUSH_INTERVAL_MS`). `NEXUS_PHONE_PEER` and `NEXUS_PRESENCE_USER` remain on the
deliberately-deferred list (plan 022) and MUST NOT be added.

### Requirement: audit-suppressions — narrow A2 suppression for test-skip-reason diagnostics
`.audit-suppressions.json` MUST carry a second, separate A2 `suppressions` stanza (distinct
from the existing CLI-scripts stanza) scoped to exactly the 3 files containing the 4 guarded
test-skip-reason `console.log` sites: `apps/agent/src/services/process-watcher.test.ts`,
`apps/agent/src/services/process-watcher.integration.test.ts`,
`apps/agent/src/routes/health-process-watcher.test.ts`. `A2` MUST NOT be added to
`autoSkipTestFiles` — a global test-file skip would also hide a genuine leaked
`console.log` elsewhere.

## Scope
- **IN**: `.env.example` (2 insertions), `.audit-suppressions.json` (1 new stanza)
- **OUT**: any source file under `apps/agent/src/` or `packages/db/`; `autoSkipTestFiles`;
  the 17 other pre-existing unrelated failures in `audit-suppressions.integration.test.ts`
  (E5, B4, composite-score-floor, stale `apps/nextjs` paths); a docs-sweep enforcement gate
  (raised separately, not built here)

## Testing
| Affected seam | Unit task | E2E task |
|----------------|-----------|----------|
| `.env.example` H1 audit coverage | N/A — doc-only, no test harness parses this file | [4.1] `audit-scan` H1 count 16→10 |
| `.audit-suppressions.json` A2 suppression | [4.2] pre-existing regression test flips red→green | N/A — no user-facing flow |

## Impact
| Area | Change |
|------|--------|
| `.env.example` | +12 lines (2 new blocks, 1 edited comment) |
| `.audit-suppressions.json` | +1 stanza (8 lines) |

## Risks
| Risk | Mitigation |
|------|-----------|
| A2 suppression scoped too broadly, hiding a real leaked `console.log` | Path-scoped to exactly 3 files, not added to `autoSkipTestFiles` (global skip explicitly rejected in plan 037) |
| `.env.example` edit touches an existing var's default/comment | Scope limited to insertion only; existing blocks (`HEALTH_PUSH_INTERVAL_MS`, `CRON_RUNS_RETENTION_DAYS`, etc.) unchanged |
