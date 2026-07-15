<!-- beads:epic:nx-u2m9a -->
<!-- beads:feature:nx-1ztmx -->

# Tasks

## API Batch

- [ ] Add `PERMISSION_REQUEST_SUPPRESSION_WINDOW_MS = 2_000` constant to `apps/agent/src/notifications/hook-trigger.ts`, alongside the existing `SUPPRESSION_WINDOW_MS`. [beads:nx-lwvnc]
- [ ] Update `suppressionKey()` in `apps/agent/src/notifications/hook-trigger.ts`: the `permission_request` case returns the template-literal key `permission_request:<session_id ?? "unknown">` (was `return null`). [beads:nx-e4j12]
- [ ] Update the suppression-check block in `evaluateAndDispatch()` to use `PERMISSION_REQUEST_SUPPRESSION_WINDOW_MS` when `eventType === "permission_request"` and `SUPPRESSION_WINDOW_MS` otherwise (the window is now per-event-type, not a single constant applied to every key). [beads:nx-gtts4]
- [ ] Update the file-header suppression-policy comment block (lines ~10-22) to reflect `permission_request : session-scoped, 2s window` instead of "no suppression (always fires)". [beads:nx-v4838]

## E2E Batch

- [ ] `hook-trigger.test.ts`: add a test — two `permission_request` payloads, same `session_id`, dispatched back-to-back → `manager.send` called exactly once (assert the second call is suppressed), mirroring the existing `hook_failure` 30s-dedupe test's fake-timer setup. [beads:nx-snqyn]
- [ ] `hook-trigger.test.ts`: add a test — two `permission_request` payloads with different `session_id`s dispatched back-to-back → `manager.send` called twice (both fire). [beads:nx-ves8b]
- [ ] `hook-trigger.test.ts`: add a test — two `permission_request` payloads, same `session_id`, second one arriving after `PERMISSION_REQUEST_SUPPRESSION_WINDOW_MS` has elapsed → `manager.send` called twice (fires again post-expiry). [beads:nx-fqi1m]
- [ ] Run `bun test apps/agent/src/notifications/hook-trigger.test.ts` and paste passing output before marking this batch done (Iron Law — Verification). [beads:nx-cq1u1]
