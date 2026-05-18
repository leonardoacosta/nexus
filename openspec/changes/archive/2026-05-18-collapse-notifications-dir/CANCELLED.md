# Cancelled: collapse-notifications-dir

**Status**: cancelled (not superseded, not deferred — withdrawn)
**Date**: 2026-05-18
**Beads**: nx-29gtx (closed with this rationale)
**Wave**: 3 v2, spine-migration-2026-05-17

## Why Cancelled

The spec asserted that `apps/agent/src/notifications/` would contain only `manager.ts` after waves 1+2, with the goal of flattening to `apps/agent/src/notifications.ts`. Wave 3 v2 hard-failed when the engineer agent found the directory actually contains 7 cohesive source files + 9 tests:

- `buffer.ts` (DB CRUD + ring buffer, re-exported through `db/index.ts`)
- `meeting-state.ts` (meeting on/off state machine)
- `speakability.ts` (predicate, also consumed by `socket-server/dispatcher.ts`)
- `router.ts` (channel dispatch, rules, timeouts)
- `manager.ts` (orchestrator, meeting-aware send)
- `hook-rules.ts` (pure event→draft translators)
- `hook-trigger.ts` (impure orchestrator: settings + suppression cache)

Triage analysis (2026-05-17) confirmed:
- All 7 source files have external consumers (no dead code)
- The dir forms 3 crisp cohesion clusters (persistence/dispatch, hook translation, speakability)
- `notifications/` is already a correctly-sized module boundary, not residue

## Outcome

Spec withdrawn. The directory stays as-is. Future optics-driven consolidation can revisit Option B (merge into `dispatch.ts` + `hook-bridge.ts` + `speakability.ts`) — analysis output is preserved in this archive.

## Cross-References

- Original wave plan: `docs/apply/apply-2026-05-17-001/wave-plan.json` (wave 2 v1) and `docs/apply/apply-2026-05-17-002/wave-plan.json` (wave 3 v2)
- Spine-migration epic: `nx-ma6h8`
- Triage source: triage agent run 2026-05-17, transcript in spine-migration-2026-05-17-v2 wave 3
