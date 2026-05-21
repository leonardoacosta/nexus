# Tasks: notifications-overhaul

<!-- beads:epic:nx-jiqt9 -->
<!-- beads:feature:nx-iv0zy -->

## DB Batch

- [x] 1.1 Extend `packages/db/src/schema/notifications.ts` with `audio_path text` (nullable) and `voice_used text` (nullable). Both default NULL for back-compat. [beads:nx-mmnzn]
- [x] 1.2 Add `packages/db/src/schema/projectVoiceOverrides.ts` — `project_voice_overrides` table: `project text PK`, `voice_id text NOT NULL`, `updated_at timestamptz NOT NULL DEFAULT now()`. Export from `packages/db/src/schema/index.ts` and root `packages/db/src/index.ts` with `ProjectVoiceOverride` + `NewProjectVoiceOverride` types. [beads:nx-zsxva]
- [x] 1.3 Generate `packages/db/drizzle/0035_add_notification_audio_and_project_voices.sql` via drizzle-kit (assigned the next available slot 0035, spec said 0036). [beads:nx-273ls]

## API Batch

- [x] 2.1 Add `apps/agent/src/notifications/audio-store.ts` — `writeAudio(notificationId, mp3Bytes): Promise<string>` writes to `~/.config/nexus/audio/<id>.mp3` and returns the path. `readAudioPath(id)` returns the path or null. `audioExists(id)` returns boolean (stat-based). `pruneAudioOlderThan(days)` deletes files matching the age threshold. [beads:nx-5vvhu]
- [x] 2.2 Wire `audio-store.writeAudio` into `apps/agent/src/notifications/manager.ts` — exposes `recordSynthesisedAudio(notificationId, mp3Bytes, voiceId)` that writes the file and stamps `audio_path` + `voice_used` columns. **Architectural note**: TTS synthesis happens Mac-side (TTSObserver) — the agent provides this storage facility but does not currently produce the bytes itself. The Mac upload path (POST audio bytes back to agent) is a follow-up. [beads:nx-e4qt4]
- [x] 2.3 Add `apps/agent/src/notifications/audio-store.test.ts` covering: writeAudio creates directory + file, readAudioPath returns null for missing rows, audioExists returns false for pruned files, pruneAudioOlderThan deletes correctly by mtime. [beads:nx-iy830]
- [x] 2.4 Extend `apps/agent/src/services/cron.ts` to add `~/.config/nexus/audio/` to the existing daily `maintain` prune sweep. Same 30-day threshold pattern (calls `pruneAudioOlderThan(30)`). [beads:nx-tu9pn]
- [x] 2.5 Add `apps/agent/src/routes/notifications-audio.ts` exporting `handleNotificationAudio(id, request)`. Validates id, looks up the row, checks `audio_path`, stat-checks the file. Returns 200 with `Content-Type: audio/mpeg` body (or 206 for range), 404 if no row or no path, 410 if path was set but file missing. Range support via `Bun.file().slice()`. [beads:nx-1mzd6]
- [x] 2.6 Add `apps/agent/src/routes/notifications-audio.test.ts` covering each scenario in the spec: stream full mp3, range request, 404 no-row, 404 no-audio-path, 410 pruned-file. [beads:nx-61dtm]
- [x] 2.7 Add `apps/agent/src/routes/notifications-voices.ts` exporting `handleListVoices()`, `handlePutVoice(project, body)`, `handleDeleteVoice(project)`. PUT validates body schema `{ voice_id: string (non-empty) }`. All write paths emit `VoiceOverrideChanged` on the lifecycle bus (-> SSE stream) after the DB write commits. [beads:nx-bfmmy]
- [x] 2.8 Register `/notifications/:id/audio` and `/notifications/voices*` routes in `apps/agent/src/server-request-handler.ts`. Voices routes register BEFORE the audio route. [beads:nx-d1hi5]
- [x] 2.9 Add `apps/agent/src/routes/notifications-voices.test.ts` covering all spec scenarios: insert, update, list, delete, idempotent delete on missing row, SSE event emitted on PUT and DELETE. [beads:nx-tmxtu]
- [x] 2.10 Extend `apps/agent/src/routes/notifications.ts handleListNotifications` to include `audioAvailable` (computed via `audio-store.audioExists(id)` per row) and `voiceUsed` (passthrough from column) in each response row. Older Swift clients ignore the new fields. [beads:nx-vqnxe]

## UI Batch

- [x] 3.1 Extend `apps/swift/NexusShared/Models/Notification.swift` (file named `Notification.swift`, not `NotificationItem.swift` as the spec said) with optional `audioAvailable: Bool?`, `voiceUsed: String?`. Both nullable for back-compat. Codable round-trip test added in `NexusSharedTests/NotificationAudioFieldTests.swift` (old + new payload coverage). [beads:nx-1up8o]
- [x] 3.2 Extend `apps/swift/NexusShared/Networking/NexusClient.swift` with `streamNotificationAudio(id:) -> AsyncThrowingStream<Data, Error>`, `fetchProjectVoices()` -> `[String: String]`, `putProjectVoice(project:voiceId:)`, `deleteProjectVoice(project:)`. Same surface on `NexusAggregateClient.swift` via fan-out. [beads:nx-ka1br]
- [x] 3.3 In `apps/swift/NexusShared/Observers/TTSObserver.swift`, added `projectVoiceCache: [String: String]` map (MainActor-isolated). Populated on `start()` via `fetchProjectVoices`. SSE subscription on `/events/stream` filters for `VoiceOverrideChanged` and refreshes the cache. Voice resolution chain at synth time: project override → Keychain global → SettingsStore preference → system synth fallback. [beads:nx-2ae5p]
- [x] 3.4 Added `SSEEvent.decodeVoiceOverrideChange()` extension that parses the agent's `VoiceOverrideChanged { project: String }` envelope shape (handles both bare and `payload`-nested forms). TTSObserver consumes via the existing events SSE stream. [beads:nx-vjds8]
- [x] 3.5 In `NotificationsView.swift`, added `NotificationSortMode` enum (`time` / `project` / `session`) backed by `@AppStorage("notifications.sort")`. Static `NotificationsView.sorted(events, mode:)` applies the mode. Header `Picker(.segmented)` with three labels. [beads:nx-72ay6]
- [x] 3.6 Added "Group" `@AppStorage("notifications.group")` toggle — visible only when sortMode is `.project` or `.session`. When ON, rows render inside `DisclosureGroup` sections keyed by the group field via static `grouped(events, mode:)`. Misc (nil) group sorts last. [beads:nx-nurnp]
- [x] 3.7 Added `NotificationReplayButton.swift` — view taking `(notificationId, audioAvailable, player)`. Tap streams `NexusAggregateClient.streamNotificationAudio` into the player. Shows stop icon during playback. [beads:nx-tqv3b]
- [x] 3.8 `NotificationHistoryRow` mounts `NotificationReplayButton` when `event.audioAvailable == true`; hidden otherwise (back-compat: older agents that omit the key leave the row identical). [beads:nx-xp96s]
- [x] 3.9 Added `ElevenLabsStatusChip.swift` — chip + `ElevenLabsStatusPopover` with three states (`keySet` / `noKey` / `keyInvalid` / `unknown`). Popover hosts masked SecureField, eye toggle, Save + Test buttons. Test failure flips model state to `.keyInvalid`. [beads:nx-iqvhw]
- [x] 3.10 `ElevenLabsStatusChip` mounted in the NotificationsView header. Tap toggles the popover via `model.toggleElevenLabsPopover()`. State derived from the Keychain on init; refreshed on Save / Test outcomes. [beads:nx-vnzdd]
- [x] 3.11 Added `ProjectVoicesView.swift` with `ProjectVoicesViewModel` — row per (project slug, voiceId text field, Test, Save, Delete). New project addable via slug + voiceId text fields + Add button. Optimistic local mutate, server PUT/DELETE via `NexusClient.put/deleteProjectVoice`, rollback on error. [beads:nx-bmw0d]
- [x] 3.12 Mounted `ProjectVoicesView` inside `ElevenLabsSettingsView` (new `Project voices` Section). Single global voice field stays as the fallback when no per-project override matches. [beads:nx-jro18]
- [x] 3.13 Added `nexus-mac/Tests/NotificationsViewTests.swift` covering sort by time / project / session, group-by Misc-last placement, replay button visibility logic (7 tests, all pass). [beads:nx-f8bp4]
- [x] 3.14 Added `nexus-mac/Tests/ProjectVoicesViewTests.swift` covering add-new sort placement, empty-slug rejection, optimistic delete (3 tests, all pass). [beads:nx-r0lj6]

## E2E Batch

- [ ] 4.1 [DEFERRED] End-to-end: trigger a TTS-eligible notification, wait for synthesis, curl `GET /notifications/<id>/audio`, assert response 200 with `Content-Type: audio/mpeg` and non-empty body. Confirm `audio_path` is set in the DB row. **Blocked**: agent-side TTS synthesis pipeline does not exist yet (Mac-owned synth). Will run after the Mac listener gains an audio-upload path. [beads:nx-s3uj7]
- [ ] 4.2 [DEFERRED] End-to-end: curl `PUT /notifications/voices/nx { voice_id: "voice-XYZ" }`, then `GET /notifications/voices`, assert the new override appears. Trigger a notification with `project: "nx"`, assert `voiceUsed: "voice-XYZ"` in the row. **Defer**: requires homelab deploy. [beads:nx-ldhf6]
- [ ] 4.3 [DEFERRED] End-to-end: subscribe to `/events/stream` SSE, issue `PUT /notifications/voices/oo`, assert `VoiceOverrideChanged { project: "oo" }` arrives within 2 seconds. **Defer**: requires homelab deploy. [beads:nx-q9me4]
- [ ] 4.4 [user] Open Nexus.app Notifications tab. Confirm: (a) sort picker switches between Time / Project / Session; (b) Group toggle collapses by section in Project/Session modes; (c) replay button plays cached audio; (d) ElevenLabs chip popover opens and Test button works; (e) Settings → ProjectVoicesView add/edit/delete round-trips correctly. [beads:nx-3grg9]
