# Proposal: Analytics Query and TTS Synthesis

## Change ID
`analytics-query-and-tts-synthesis`

## Why

The notification-store capability has two production regressions and two
spec drifts that block validation of recent reaper/lifecycle work. The TTS
channel was silently collapsed into a signal-only stub during a refactor,
so ElevenLabs audio never reaches listeners even when `ELEVENLABS_API_KEY`
is set — spec says it should. The analytics surface still has no way to
query the `notifications` table (the analytics route stub exists but does
not expose the notifications history), so we cannot verify persistence
end-to-end without opening the SQLite file. In parallel, the dedup key
ignores `project`, so legitimately distinct notifications for two
different projects in the same 5 s window get suppressed, and the
no-op PATCH on `/notifications/settings` always broadcasts
`SettingsChanged` and bumps `updated_at`, contradicting the spec's
"no-op MUST NOT broadcast" scenario. This change restores synthesis,
adds the analytics query path, and tightens both correctness bugs.

## What Changes

- Add `GET /analytics/notifications?hours=N&project=X&status=Y` handler that
  queries the `notifications` table and returns paginated rows with
  timestamps and delivery state.
- Restore ElevenLabs synthesis in the TTS channel handler: when the API
  key is set and `tts_enabled=true`, call ElevenLabs, persist the mp3 to
  `~/.config/nexus/audio/<id>.mp3` via the existing audio-store helper, and
  attach base64 `audioBase64` to the `NotificationFired` payload. When the
  key is unset, still mark delivered, omit `audioBase64`, and let the
  listener handle silence.
- Fix the dedup target so `target = hash(message + "|" + (project || "") +
  "|" + channel)`, so the same banner text for two different projects in
  the same 5 s window is no longer suppressed.
- Make `PATCH /notifications/settings` truly idempotent: compare the
  incoming patch to the current row and only emit `SettingsChanged` and
  bump `updated_at` when at least one field actually changed.
- Add a migration / boot-time idempotent seed so
  `(1, true, true, 'full', now)` always exists in `notification_settings`
  on a fresh agent boot.

## Context

- depends on: (none)
- touches: `apps/agent/src/routes/analytics.ts`, `apps/agent/src/routes/notifications.ts`, `apps/agent/src/notifications/manager.ts`, `apps/agent/src/notifications/router.ts`, `apps/agent/src/routes/notification-settings.ts`, `packages/db/drizzle/<new>.sql`
- related capability: `notification-store` (existing spec at `openspec/specs/notification-store/spec.md`)

Note: the request referenced `apps/agent/src/services/notification-manager.ts`
and `apps/agent/src/services/channels/tts.ts`. The actual code lives at
`apps/agent/src/notifications/manager.ts` (manager) and
`apps/agent/src/notifications/router.ts` (channel dispatch — the TTS
channel handler `sendTtsNotification` is currently aliased to
`signalOnlyChannel` here, which is the regression). Paths above reflect
the real layout.

## Impact

| Area | Change |
|------|--------|
| Capability | `notification-store` (MODIFIED + ADDED requirements) |
| Breaking? | No — `audioBase64` is optional; analytics endpoint is additive; dedup key change is server-side only |
| Migrations? | Yes — one new SQL migration in `packages/db/drizzle/` to guarantee the `notification_settings` seed row exists (idempotent `INSERT … ON CONFLICT DO NOTHING`) |
| Files changed (est.) | ~6 source files + 1 SQL migration + ~3 test files |
| Risk | Low — restores deleted behaviour, tightens an existing dedup key, adds a read-only endpoint, and adds a comparison branch in an existing PATCH handler |
