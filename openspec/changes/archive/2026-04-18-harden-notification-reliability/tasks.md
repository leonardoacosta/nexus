# Implementation Tasks

<!-- beads:epic:nx-uj6t -->

## API Batch

- [x] [1.1] [P-1] Audit meeting-state call sites: grep for `MeetingState.start`/`MeetingState.end` / `startMeeting`/`endMeeting` — confirm no caller relies on silent re-entry (guards already live; audit to verify no silent-re-entry assumptions in integration tests) [owner:api-engineer] [beads:nx-2wv3] — no call-site changes needed: routes/notifications.ts:180 calls startMeeting() and endMeeting() unconditionally; notifications.test.ts exercises start/end cycle cleanly; no caller expects silent re-entry
- [x] [1.2] [P-0] SKIP — `MAX_BUFFER_SIZE` (1000) + FIFO eviction already implemented in `apps/agent/src/notifications/buffer.ts:12,77-80`. Spec delta only; no code change. [beads:nx-by4k]
- [x] [1.3] [P-0] SKIP — State guards already implemented in `apps/agent/src/notifications/meeting-state.ts` using `InvalidStateError`. Spec delta only; no code change. [beads:nx-uz89]
- [x] [1.4] [P-1] Wrap channel handler invocations in `routeNotification()` and `routeNotificationParallel()` in `apps/agent/src/notifications/router.ts` with a `Promise.race` timeout (default 10s, read from `NEXUS_NOTIFICATION_TIMEOUT_MS`). On timeout: emit `Sentry.captureException` with channel name and notification id, push channel to `failed` / skip in results [owner:api-engineer] [beads:nx-g6av]
- [x] [1.5] [P-1] Add `Sentry.addBreadcrumb` call alongside existing `log.warn` in the unknown-channel branches of both `routeNotification()` (line ~69) and `routeNotificationParallel()` (line ~91) in `router.ts`. Breadcrumb MUST name the missing channel [owner:api-engineer] [beads:nx-ug5w]

## E2E Batch

- [x] [2.1] Unit test buffer: insert >1000 → assert size stays at 1000 and the first entries are evicted (FIFO) [owner:e2e-engineer] [beads:nx-qpcb]
- [x] [2.2] Unit test meeting-state: double-start throws `InvalidStateError`; end-without-start throws `InvalidStateError`; start-end-start succeeds [owner:e2e-engineer] [beads:nx-vogc]
- [x] [2.3] Unit test router: mock slow handler (never resolves) + assert timeout fires within bound + `Sentry.captureException` called with channel info [owner:e2e-engineer] [beads:nx-cchl]
- [x] [2.4] Unit test router: notification to unknown channel → `log.warn` emitted + `Sentry.addBreadcrumb` called naming the missing channel [owner:e2e-engineer] [beads:nx-bf32]
