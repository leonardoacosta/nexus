---
stack: t3
---
<!-- beads:epic:nx-oxbf8 -->
<!-- beads:feature:nx-m0ijd -->

# Implementation Tasks

## API Batch

- [x] [1.1] In `packages/core/src/types/session-context.ts` (line ~24), change `usedPercentage: z.number().min(0).max(100)` to `usedPercentage: z.number().min(0)` in `sessionContextPatchInput`. Add a test case to `apps/agent/src/routes/session-context.test.ts` (near the existing `patchRequest` boundary tests, e.g. around line 207's "boundary" case) asserting `PATCH /sessions/:id/context` with `{usedPercentage: 175.0, contextWindowSize: 200000}` returns `204` and a subsequent `GET` returns `usedPercentage: 175.0` exactly. Run the existing test suite for this file and paste PASS output. [beads:nx-7w186]
- [x] [1.2] Runtime-verify against the live dev agent: `curl -X PATCH http://localhost:7400/sessions/<a-test-session-id>/context -H 'Content-Type: application/json' -d '{"usedPercentage":175.0,"contextWindowSize":200000}'` returns `204`, then `curl http://localhost:7400/sessions/<same-id>/context` returns `usedPercentage: 175.0`. Paste both curl outputs. [beads:nx-yf6b8]
  - depends on: 1.1

## E2E Batch

- [x] [2.1] Targeted `git add packages/core/src/types/session-context.ts apps/agent/src/routes/session-context.test.ts` (no `git add -A`/`.`); commit `fix(session-context): relax usedPercentage upper bound to accept over-window values`; push through the normal deploy hook (confirm `systemctl --user status nexus-agent` picks up the new build per this repo's own deploy convention). Paste confirmation the running build reflects the change (e.g. a live curl round-trip above 100 succeeding against the deployed instance, not just localhost dev). [beads:nx-byz2q]
  - depends on: 1.1, 1.2
