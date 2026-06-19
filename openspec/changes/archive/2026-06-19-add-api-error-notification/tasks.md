# Tasks: API Error Notification

<!-- beads:epic:nx-09shh -->
<!-- beads:feature:nx-c0pz7 -->

## API Batch

- [x] Add `apiErrorRule` to `apps/agent/src/notifications/hook-rules.ts` — fires on api-error [beads:nx-06bbb]
  events and `stop_reason="api_error"` stops; emits `desktop` + `tts` drafts, `priority: high`,
  `severity: error`, body includes project code + error text
- [x] Modify `sessionStopRule` so its crash branch excludes `api_error` (cedes to `apiErrorRule`), [beads:nx-kaxig]
  retaining `error`, `crash`, `timeout`, `oom`
- [x] Extend `apps/agent/src/credentials/token-stream/tail-watcher.ts` to detect [beads:nx-ldcbt]
  `isApiErrorMessage: true` (or `^API Error:` content) lines and invoke a new `onApiError`
  callback alongside `onTurns`
- [x] Wire the `onApiError` callback to post a `notification` socket event with the api-error [beads:nx-9cz4h]
  text, project, and `session_id` through the existing dispatcher path
- [x] Add an optional `reason: "api_error"` discriminator to the `notification` event in [beads:nx-gknjj]
  `apps/agent/src/types/socket-events.ts` so `apiErrorRule` can distinguish mid-session emits
- [x] Register `apiErrorRule` in `apps/agent/src/notifications/hook-trigger.ts` with per-session [beads:nx-avasg]
  suppression key `api_error:<session_id>` using the existing 30s window
- [x] Confirm the tail-watcher lifecycle covers live sessions; if not, gate mid-session detection [beads:nx-ybwuz]
  and document the limitation in the rule comment

## E2E Batch

- [x] Unit-test `apiErrorRule`: mid-session emit produces desktop+tts drafts; crash-stop [beads:nx-4elo3]
  `api_error` produces desktop+tts; non-api crash produces no api-error draft
- [x] Unit-test `sessionStopRule` no longer emits for `api_error` but still emits for `oom` [beads:nx-nsjif]
- [x] Test tail-watcher detects `isApiErrorMessage: true` lines and invokes `onApiError`; [beads:nx-t2r5z]
  asserts usage-bearing lines still parse as turns
- [x] Test per-session throttle: three rapid api errors on one session collapse to one delivered [beads:nx-43gyj]
  notification; two sessions in the same window each deliver
