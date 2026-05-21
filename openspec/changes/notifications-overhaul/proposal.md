---
status: draft
---

# Proposal: notifications-overhaul

## Why

Four gaps in the Notifications tab and TTS pipeline:

1. **Sort is fixed.** `NotificationsView.swift:290` hard-sorts by
   `receivedAt > $1.receivedAt`. There's no project/session grouping
   or alternate ordering. When the dashboard has 200 notifications,
   finding "what nx-9m0re said today" is a manual scroll.

2. **ElevenLabs key control buried.** The key lives in Keychain, paste
   UI is in `ElevenLabsSettingsView.swift` — a separate Settings tab.
   No visibility from the Notifications tab itself (no usage shown,
   no quick re-paste, no test affordance). When the key expires the
   user has to navigate two tabs deep to fix it.

3. **No mp3 replay.** Each notification synthesises voice once, plays
   it, and discards the bytes. There's no way to re-hear a notification
   the user missed (loud room, headphones disconnected, etc.). The
   TTS pipeline already produces MP3 bytes — keeping them costs ~50KB
   per notification and unlocks scrubbing/replay UX.

4. **Single global voice ID.** `Keychain.elevenLabsVoiceId` holds one
   voice for the whole app. Leo's brief asks for per-project voices —
   `nx` rings with one voice, `oo` with another. The infrastructure
   needs a `project → voiceId` mapping plus a resolver in TTSObserver.

The fix is one consolidated rewrite touching the agent (mp3 storage,
voice-config endpoints) and the Swift dashboard (sort controls,
inline key UI, replay buttons, per-project voice settings).

## What Changes

1. **MP3 storage on the agent** — TTS dispatch writes synthesised MP3
   bytes to `~/.config/nexus/audio/<notif_id>.mp3`. New
   `notifications.audio_path text` column points at the file when
   present. Retention: 30 days, pruned by the existing cron service
   (same pattern as failure JSONL files).

2. **`GET /notifications/:id/audio` endpoint** — streams the cached
   MP3 with `Content-Type: audio/mpeg`. 404 when the file is absent
   (older notifications or TTS-disabled rows). Range requests
   supported for progressive playback. Returns 410 Gone if the row
   exists but the file was pruned by retention.

3. **`project_voice_overrides` table + endpoints** — single-row-per-
   project schema (`project text PK`, `voice_id text`, `updated_at`).
   New endpoints: `GET /notifications/voices`, `PUT /notifications/voices/:project`,
   `DELETE /notifications/voices/:project`. Resolution order at TTS
   time: project override → global Keychain `elevenLabsVoiceId` →
   fallback to system synth.

4. **Notifications list payload extensions** — `GET /notifications`
   gains `audioAvailable: boolean` per row (derived from
   `audio_path IS NOT NULL`), plus `voiceUsed: string | null` (the
   voice id that produced the audio — useful when debugging per-
   project resolution). Both optional in Swift decoder for
   back-compat.

5. **TTSObserver voice resolver** — on each synthesise call, lookup
   `projectVoices[notification.project]` from a cached map (fetched
   on launch via new GET endpoint, refreshed on PUT/DELETE via SSE
   nudge). Falls back to the global keychain voice if unmapped.

6. **NotificationsView UI** — five additive pieces:
   - **Sort picker** — header chip: `Time ↓` | `Project ↑` | `Session ↑`.
     `@AppStorage` persists choice. Apply client-side; no re-fetch.
   - **Group-by toggle** — when sort = Project or Session, optionally
     collapse into accordion sections per group.
   - **Replay button** — row-level `▶︎` button when `audioAvailable
     == true`. Tap streams `/notifications/:id/audio` into `MP3Player`
     (already shipped). On-the-fly fetch — no eager download.
   - **ElevenLabs status chip** — header-mounted chip showing
     `key set | no key | key invalid`. Tap opens a popover with
     paste field + Test button + masked-show of current key. Mirrors
     the existing `ElevenLabsSettingsView` but inline.
   - **Per-project voice editor** — Settings tab gains a
     `ProjectVoicesView`: row per discovered project with a voice-id
     text field. Save → `PUT /notifications/voices/:project`. Delete
     icon → `DELETE` for the row. New project rows manually-addable
     (typed slug).

## Context

- depends on: 
- touches: `packages/db/src/schema/notifications.ts`, `packages/db/src/schema/projectVoiceOverrides.ts`, `packages/db/drizzle/0036_add_notification_audio_and_project_voices.sql`, `apps/agent/src/notifications/manager.ts`, `apps/agent/src/notifications/audio-store.ts`, `apps/agent/src/notifications/audio-store.test.ts`, `apps/agent/src/services/cron.ts`, `apps/agent/src/routes/notifications.ts`, `apps/agent/src/routes/notifications-audio.ts`, `apps/agent/src/routes/notifications-audio.test.ts`, `apps/agent/src/routes/notifications-voices.ts`, `apps/agent/src/routes/notifications-voices.test.ts`, `apps/swift/NexusShared/Models/NotificationItem.swift`, `apps/swift/NexusShared/Networking/NexusClient.swift`, `apps/swift/NexusShared/Networking/NexusAggregateClient.swift`, `apps/swift/NexusShared/Observers/TTSObserver.swift`, `apps/swift/nexus-mac/Sources/Dashboard/NotificationsView.swift`, `apps/swift/nexus-mac/Sources/Dashboard/NotificationReplayButton.swift`, `apps/swift/nexus-mac/Sources/Dashboard/ElevenLabsStatusChip.swift`, `apps/swift/nexus-mac/Sources/Dashboard/ProjectVoicesView.swift`, `apps/swift/nexus-mac/Sources/ElevenLabsSettingsView.swift`

NexusClient + NexusAggregateClient touched again (5th spec in this
session). Append-only methods. wave-plan-build serializes the wave.

Audio store + cron retention pattern reuses the same JSONL-prune model
shipped earlier (`adopt-reaper-into-nx-cron` cleanup capability). Drift
to be aware of: the reaper currently prunes
`~/.claude/scripts/state/failures/*.jsonl`; we add another path
(`~/.config/nexus/audio/*.mp3`, age >30d) to the same sweep loop. No
new cron job needed.

## Risk

- **Disk growth from mp3 cache.** 50KB per notification × 100 per day
  × 30 days = ~150MB steady state. Acceptable on Mac dev laptop and
  homelab. Mitigation: retention prunes >30d aggressively; admin
  endpoint `POST /notifications/audio/purge` for manual cleanup.
- **Bytes-on-disk vs DB blob.** Filesystem chosen for streaming
  efficiency (range requests, no DB IO). Trade-off: the file can drift
  out of sync with the row (e.g. operator manually deletes file).
  Mitigation: `audioAvailable` is computed via `stat(audio_path)` at
  request time, not just from the column.
- **Per-project voice resolver cache staleness.** TTSObserver caches
  the `project → voiceId` map for the session. A PUT during a long-
  lived session won't be picked up without an SSE nudge. Mitigation:
  emit a `VoiceOverrideChanged` event on the existing
  `/notifications/events` SSE stream; observer drains it and refetches.
- **Sort by project/session with mixed nil values.** Some notifications
  lack project (system notifications). Mitigation: client-side sort
  puts nil-project rows in a "Misc" group at the bottom, never inline.
- **mp3 replay during active TTS playback.** User clicks replay while
  another notification's voice is already playing. Mitigation:
  `MP3Player` already shipped supports interrupt-on-play (ducking
  semantics); replay slots into the same actor.
