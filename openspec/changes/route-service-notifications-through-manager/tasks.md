---
stack: t3
---
<!-- beads:epic:nx-i4sp1 -->
<!-- beads:feature:nx-2y1ir -->

# Tasks — route-service-notifications-through-manager

## API Batch

- [ ] 1.1 Add `NotificationManager.sendServiceNotification(payload: NotificationFiredPayload)` — accepts the minimal id/title/body/message/channel shape the 5 bypass sites already build, fills in the `NotificationRow` columns `send()` requires with defaults matching current bypass behavior (no `project` unless the caller supplies one; `severity: "info"`; `priority` defaulted so project-less rows are never rate-throttled, matching `send()`'s existing project-less skip at `manager.ts:235`), and calls `send()` internally so the same meeting-hold/presence/quiet-hours gating applies. [type:api] [beads:nx-l35xz]
  - touches: `apps/agent/src/notifications/manager.ts`
- [ ] 1.2 Redirect `proactive-swap.ts`'s `notify` default (currently `(p) => lifecycleBus.emit("NotificationFired", p)` at `:261`) to call `manager.sendServiceNotification(p)` instead — thread the manager instance through `EvaluateProactiveSwapOpts` (new required or defaulted-to-singleton field, matching how `db`/`pool` are already threaded). [type:api] [beads:nx-162fo]
  - touches: `apps/agent/src/services/proactive-swap.ts`
- [ ] 1.3 Same redirect for `reaper-job.ts`'s two `lifecycleBus.emit("NotificationFired", ...)` call sites (`:454,471,601,609`). [type:api] [beads:nx-lo6d6]
  - touches: `apps/agent/src/services/reaper-job.ts`
- [ ] 1.4 Same redirect for `deploy-staleness.ts` (`:397,406`). [type:api] [beads:nx-h04g5]
  - touches: `apps/agent/src/services/deploy-staleness.ts`
- [ ] 1.5 Same redirect for `data-integrity-scan.ts` (`:206,214`). [type:api] [beads:nx-qj8pm]
  - touches: `apps/agent/src/services/data-integrity-scan.ts`
- [ ] 1.6 Same redirect for `credential-swap-flow.ts`'s `notify` default (`:87,129-130`). [type:api] [beads:nx-35yjx]
  - touches: `apps/agent/src/services/credential-swap-flow.ts`

## E2E Batch

- [ ] 2.1 New `manager.integration.test.ts` cases: a service-shaped notification (no `project`) submitted via `sendServiceNotification()` is held during an active meeting and flushed via the existing coalesced-summary path; a service notification fired during quiet hours is suppressed the same way an HTTP-originated one is. [type:testing] [beads:nx-bcunm]
  - touches: `apps/agent/src/notifications/manager.integration.test.ts`
- [ ] 2.2 Existing test suites for all 5 touched services still pass — their `notify` injection seam still intercepts calls in tests (no test rewrite required beyond whatever the redirect needs). Run and paste: `bun test apps/agent/src/notifications apps/agent/src/services`. [type:testing] [beads:nx-7qmqo]
