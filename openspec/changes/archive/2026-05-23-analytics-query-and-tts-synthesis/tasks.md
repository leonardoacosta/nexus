<!-- beads:epic:nx-jiqt9 -->
<!-- beads:feature:nx-rh15n -->

# Tasks: Analytics Query and TTS Synthesis

## DB Batch

- [ ] Add migration `packages/db/drizzle/<next>_notification_settings_seed.sql` with `INSERT INTO notification_settings (id, tts_enabled, banner_enabled, ducking_mode, updated_at) VALUES (1, true, true, 'full', now()) ON CONFLICT (id) DO NOTHING;`
- [ ] Add boot-time idempotent seed verification in `apps/agent/src/db/index.ts` (or migrate runner) that runs the seed insert at startup as a safety net even if the migration was skipped
- [ ] Ensure `~/.config/nexus/audio/` directory is bootstrapped on agent boot (via the existing `audio-store` helper) so the TTS path never fails on first synthesis

## API Batch

- [ ] Implement `handleAnalyticsNotifications(db, url)` in `apps/agent/src/routes/analytics.ts` that reads `?hours=N&project=X&status=Y` and returns paginated rows from the `notifications` table with timestamps and delivery state
- [ ] Restore ElevenLabs synthesis in `apps/agent/src/notifications/router.ts` — replace the `signalOnlyChannel` alias for `sendTtsNotification` with a real handler that calls ElevenLabs when `ELEVENLABS_API_KEY` is set, persists the mp3 via `audio-store`, and emits `NotificationFired` with `audioBase64`
- [ ] Change the dedup key in `apps/agent/src/routes/notifications.ts` `isDuplicate(message, target)` so `target = hash(message + "|" + (project || "") + "|" + channel)` (currently `target = channel` only) and update the call site at line ~166-167 to pass `project` through
- [ ] In `apps/agent/src/routes/notification-settings.ts` PATCH handler (line ~200-220), `SELECT` the current row first and short-circuit when the merged patch matches; only run the `UPDATE … SET updated_at = now()` and `lifecycleBus.emit("SettingsChanged", …)` when at least one field actually changed
- [ ] Add a typed `AnalyticsNotificationRow` shape in `packages/core` (or the agent's local types) and export it for the route handler to return
- [ ] Add structured error handling for ElevenLabs failures: HTTP 4xx/5xx, network timeout, and missing voice id MUST capture to Sentry via existing `captureException` path and mark the TTS channel as failed without emitting `NotificationFired`

## UI Batch

- [ ] (none — backend-only spec; Swift/macOS listener changes are out of scope)

## E2E Batch

- [ ] Add `apps/agent/src/routes/analytics.test.ts` coverage for `GET /analytics/notifications` — seed three notifications across two projects + two statuses, assert filter combinations return the expected subset
- [ ] Add a round-trip test in `apps/agent/src/notifications/router.test.ts` that mocks the ElevenLabs HTTP endpoint, asserts `audioBase64` is on the emitted `NotificationFired`, and that the mp3 is persisted under `~/.config/nexus/audio/<id>.mp3`
- [ ] Extend `apps/agent/src/routes/notifications-dedup.test.ts` with a scenario that submits the same message body for two different `project` values within 5 s and asserts both are delivered (neither suppressed)
