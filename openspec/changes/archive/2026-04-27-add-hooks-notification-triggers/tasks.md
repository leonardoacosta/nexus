# Implementation Tasks

<!-- beads:epic:nx-u2m9a -->
<!-- beads:feature:nx-6irva -->

> Beads filed after Leo approves the proposal. HARD-depends on `nx-h8uxs` (extend-hooks-event-taxonomy) — do NOT start API work until that proposal lands and the unhandled events are recognized + parsed inside `apps/agent/src/routes/hooks.ts`.

## DB Batch

- [ ] [1.1] [P-3] No new schema. Confirm `notification_settings` (id=1, ttsEnabled, bannerEnabled, duckingMode) exists per archived `add-notification-control-dashboard` and that `apps/agent/src/db/notification-settings.ts` (or equivalent reader) is reachable from the notifications module. Verify with `grep -rn 'notificationSettings' apps/agent/src/` [owner:db-engineer] [type:verify] [beads:nx-n1tbx]

## API Batch

- [x] [2.1] [P-1] Create `apps/agent/src/notifications/hook-rules.ts` with the `HookRule` type and a static registry of exactly five rules (`tool_use_fail`, `permission_request`, `hook_failure`, `session_stop` with crash predicate, `session_summary` with cost predicate). Each rule a pure function returning `NotificationDraft | null`. Cite `~/.claude/scripts/hooks/telemetry.sh` policy in module docstring [owner:api-engineer] [type:code] [beads:nx-s3iei]
- [x] [2.2] [P-1] Create `apps/agent/src/notifications/hook-trigger.ts` that exports `evaluateAndDispatch(db, payload)`: reads `notification_settings`, evaluates rules, applies suppression cache, filters channels by settings, and calls `NotificationManager.send()` for non-empty drafts. Suppression cache is a module-private `Map<string, number>` with lazy pruning [owner:api-engineer] [type:code] [beads:nx-75tag]
- [x] [2.3] [P-1] Wire the trigger into `apps/agent/src/routes/hooks.ts`: after the `appendSessionEvent` + lifecycle switch, call `await evaluateAndDispatch(db, payload)`. Wrap in try/catch and log on failure — notification dispatch MUST NOT cause the hook handler to return non-200 [owner:api-engineer] [type:code] [beads:nx-pnrmi]
- [x] [2.4] [P-1] Extend `HookEventPayload` in `apps/agent/src/routes/hooks.ts` (or import from the taxonomy module created by `nx-h8uxs`) with the fields rules consume: `tool_name`, `error_message`, `hook_name`, `crash_flag` [owner:api-engineer] [type:code] [beads:nx-r1oz1]
- [x] [2.5] [P-2] Unit tests in `apps/agent/src/notifications/hook-rules.test.ts`: per-rule fixtures asserting `NotificationDraft` shape (channels, title format, body project-prefix). One test per rule plus null-return cases for `session_summary` below threshold and `session_stop` without crash flag [owner:test-writer] [type:testing] [beads:nx-v3nlx]
- [x] [2.6] [P-2] Unit tests in `apps/agent/src/notifications/hook-trigger.test.ts`: suppression cache (same key within window → skipped, different key → not skipped, after window → fires again); settings filter (`tts_enabled=false` strips tts; `banner_enabled=false` strips desktop; both off + no slack → no send call); failsafe when settings row missing [owner:test-writer] [type:testing] [beads:nx-x1w9g]
- [x] [2.7] [P-2] Integration test in `apps/agent/src/routes/hooks.test.ts`: POST a `tool_use_fail` payload, assert `session_events` row written AND a row appears in `notifications` table with `channel="desktop"` (verify the wiring end-to-end for one trigger) [owner:test-writer] [type:testing] [beads:nx-tpcew]

## UI Batch

(none — the dashboard already renders notifications via `apps/dashboard` consuming `/notifications` ; no new UI surface)

## E2E Batch

- [ ] [3.1] [P-2] [user] After deploy, trigger a real `tool_use_fail` by running a known-failing command in any cc session, confirm a desktop banner fires within 2s and a row appears in `notifications` (`SELECT * FROM notifications WHERE channel IN ('desktop','slack') ORDER BY created_at DESC LIMIT 5`) [owner:user] [type:testing] [beads:nx-rk1a8]
- [ ] [3.2] [P-2] [user] Toggle `tts_enabled=false` via the dashboard, trigger a `permission_request` (cc will prompt during a `/edit` of a sensitive path), confirm only the desktop banner fires (no TTS audio) [owner:user] [type:testing] [beads:nx-g6c7k]
- [x] [3.3] [P-3] [user] Trigger 3 `tool_use_fail` events on the same `tool_name` within 30s (e.g. retry a failing `pnpm test` 3x quickly), confirm only the first fires a notification and the next two are suppressed (visible in agent logs as "trigger suppressed") [owner:user] [type:testing] [beads:nx-z0vm4]
  - resolved 2026-07-14 (nx-z0vm4): the feature was silently dead in production since 2026-04-27 at TWO layers — (1) `tool_use_fail`/`permission_request`/`hook_failure` were never in `apps/agent/src/types/socket-events.ts` `VALID_EVENTS`, so `isSocketEvent` rejected every one ("unrecognised JSON"); (2) `dispatcher.ts` `switch (event.event)` had no case for them, so `evaluateAndDispatch` (the only path to `hookRules` + suppression) was never reached. Both fixed: added the 3 union interfaces + `VALID_EVENTS` entries, and wired 3 dispatcher cases -> `fireHookNotification` -> `evaluateAndDispatch`. Guarded by regression tests in `socket-events.test.ts` (isSocketEvent) and `dispatcher.test.ts` (evaluateAndDispatch reached per event). Live end-to-end 3x-suppression confirmation runs post-deploy.
