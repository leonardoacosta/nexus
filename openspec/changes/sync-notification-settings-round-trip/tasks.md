---
stack: t3
---
<!-- beads:epic:nx-wi34v -->
<!-- beads:feature:nx-qij0n -->

<!-- stack: one of t3 | cc-meta | effect | dotnet — see commands/apply/references/stacks.md § "Stack vocabulary crosswalk" for the full tasks.md-stack:/--stack-profile/detect_stack() mapping -->

# Implementation Tasks

## DB Batch

- [ ] [1.1] Add `signal_only` (boolean, default false), `meeting_mode` (boolean, default false), [beads:nx-v7kvd]
  `suppression_minutes` (integer, default 0) columns to `packages/db/src/schema/notificationSettings.ts`
- [ ] [1.2] Run `pnpm --filter @nexus/db db:generate` and commit the generated migration SQL [beads:nx-s44qr]
  - depends on: 1.1

## API Batch

- [ ] [2.1] Extend `ALLOWED_KEYS` in `apps/agent/src/routes/notification-settings.ts` with [beads:nx-pe9dt]
  `signal_only`, `meeting_mode`, `suppression_minutes`; extend `SettingsResponse` type and the
  GET/PATCH handlers to read/write the three new columns
  - depends on: 1.2
- [ ] [2.2] Validate `suppression_minutes` as a non-negative integer in the PATCH handler, [beads:nx-3yiqh]
  rejecting negative values with `400`
  - depends on: 2.1
- [ ] [2.3] Extend the `SettingsChanged` lifecycle broadcast payload to include `signalOnly`, [beads:nx-fm7ms]
  `meetingMode`, `suppressionMinutes` alongside the existing fields
  - depends on: 2.1
- [ ] [2.4] Extend `apps/agent/src/routes/notification-settings.test.ts` covering: new fields [beads:nx-ihgps]
  round-trip via PATCH, negative `suppression_minutes` rejected, `SettingsChanged` payload
  includes the new fields
  - depends on: 2.2, 2.3

## UI Batch

- [ ] [3.1] Wire `SettingsTtsView.persistToggles()` to call [beads:nx-nt0tf]
  `NexusClient.patchNotificationSettings()` with `tts_enabled`/`banner_enabled`/`ducking_mode`/
  `signal_only` (snake_case), following `SettingsRoutingView.persistSettings()`'s existing
  pattern (persist local `SettingsStore` first, then PATCH, flash a save/error status)
  - depends on: 2.1
- [ ] [3.2] Fix `NotificationsView.persist()`'s PATCH body to use `meeting_mode`/`signal_only`/ [beads:nx-3yesl]
  `suppression_minutes` (snake_case) instead of the current camelCase keys, and surface a visible
  error state when the PATCH call fails instead of unconditionally showing "Saved"
  - depends on: 2.1
- [ ] [3.3] Subscribe `TTSObserver` to the `SettingsChanged` SSE event and update its cached [beads:nx-xi5qg]
  gating state (`ttsEnabled`, `banner`, `ducking`, `signalOnly`) from the event payload; extend
  `SettingsStore` if a new overlay/cache field is needed to hold the server-sourced values
  - depends on: 2.3
- [ ] [3.4] Extend `apps/swift/nexus-mac/Tests/SettingsTtsViewTests.swift` (and add [beads:nx-xzywt]
  NotificationsView / TTSObserver test coverage as needed) for: PATCH called with correct
  snake_case keys on toggle, error state shown on failed PATCH, TTSObserver gating state updates
  when a SettingsChanged event is received
  - depends on: 3.1, 3.2, 3.3

## E2E Batch

- [ ] [4.1] Manual verification: toggle TTS/banner/ducking/signal-only in `SettingsTtsView`, [beads:nx-kxx5t]
  confirm via `curl -H "x-nexus-secret: $SECRET" http://localhost:7400/notifications/settings`
  that the change persisted server-side
  - depends on: 3.1
- [ ] [4.2] Manual verification: toggle meeting-mode/signal-only/suppression in the Notifications [beads:nx-3j75q]
  drawer, confirm the same via `GET /notifications/settings`, and confirm a simulated agent-down
  PATCH failure shows a visible error (not "Saved")
  - depends on: 3.2
- [ ] [4.3] Manual verification: PATCH `/notifications/settings` directly (simulating a remote [beads:nx-99i09]
  machine's change) and confirm the local `TTSObserver`'s gating behavior updates without an app
  restart
  - depends on: 3.3
