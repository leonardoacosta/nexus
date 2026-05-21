# Tasks: notifications-overhaul

<!-- beads:epic:nx-jiqt9 -->
<!-- beads:feature:nx-iv0zy -->

## DB Batch

- [x] 1.1 Extend `packages/db/src/schema/notifications.ts` with `audio_path text` (nullable) and `voice_used text` (nullable). Both default NULL for back-compat. [beads:nx-mmnzn]
- [x] 1.2 Add `packages/db/src/schema/projectVoiceOverrides.ts` — `project_voice_overrides` table: `project text PK`, `voice_id text NOT NULL`, `updated_at timestamptz NOT NULL DEFAULT now()`. Export from `packages/db/src/schema/index.ts` and root `packages/db/src/index.ts` with `ProjectVoiceOverride` + `NewProjectVoiceOverride` types. [beads:nx-zsxva]
- [x] 1.3 Generate `packages/db/drizzle/0035_add_notification_audio_and_project_voices.sql` via drizzle-kit (assigned the next available slot 0035, spec said 0036). [beads:nx-273ls]

## API Batch

- [ ] 2.1 Add `apps/agent/src/notifications/audio-store.ts` — `writeAudio(notificationId, mp3Bytes): Promise<string>` writes to `~/.config/nexus/audio/<id>.mp3` and returns the path. `readAudioPath(id)` returns the path or null. `audioExists(id)` returns boolean (stat-based). `pruneAudioOlderThan(days)` deletes files matching the age threshold. [beads:nx-5vvhu]
- [ ] 2.2 Wire `audio-store.writeAudio` into `apps/agent/src/notifications/manager.ts` — when ElevenLabs synthesis returns MP3 bytes, persist them and update the notifications row's `audio_path` + `voice_used` columns. When synthesis fails or TTS is disabled, leave both NULL. [beads:nx-e4qt4]
- [ ] 2.3 Add `apps/agent/src/notifications/audio-store.test.ts` covering: writeAudio creates directory + file, readAudioPath returns null for missing rows, audioExists returns false for pruned files, pruneAudioOlderThan deletes correctly by mtime. [beads:nx-iy830]
- [ ] 2.4 Extend `apps/agent/src/services/cron.ts` to add `~/.config/nexus/audio/` to the existing weekly prune sweep alongside the failures JSONL path. Same 30-day threshold pattern. [beads:nx-tu9pn]
- [ ] 2.5 Add `apps/agent/src/routes/notifications-audio.ts` exporting `handleNotificationAudio(id, request)`. Validates id, looks up the row, checks `audio_path`, stat-checks the file. Returns 200 with `Content-Type: audio/mpeg` body (or 206 for range), 404 if no row or no path, 410 if path was set but file missing. Range support via standard `Bun.file().slice()` semantics. [beads:nx-1mzd6]
- [ ] 2.6 Add `apps/agent/src/routes/notifications-audio.test.ts` covering each scenario in the spec: stream full mp3, range request, 404 no-row, 404 no-audio-path, 410 pruned-file. [beads:nx-61dtm]
- [ ] 2.7 Add `apps/agent/src/routes/notifications-voices.ts` exporting `handleListVoices()`, `handlePutVoice(project, body)`, `handleDeleteVoice(project)`. PUT validates body schema `{ voice_id: string (non-empty) }`. All write paths emit `VoiceOverrideChanged` on the notifications SSE stream after the DB write commits. [beads:nx-bfmmy]
- [ ] 2.8 Register `/notifications/:id/audio` and `/notifications/voices*` routes in `apps/agent/src/server-request-handler.ts`. Voices routes MUST register BEFORE `/notifications/:id` to avoid mis-routing. [beads:nx-d1hi5]
- [ ] 2.9 Add `apps/agent/src/routes/notifications-voices.test.ts` covering all spec scenarios: insert, update, list, delete, idempotent delete on missing row, SSE event emitted on PUT and DELETE. [beads:nx-tmxtu]
- [ ] 2.10 Extend `apps/agent/src/routes/notifications.ts handleListNotifications` to include `audioAvailable` (computed via `audio-store.audioExists(id)` per row) and `voiceUsed` (passthrough from column) in each response row. Older Swift clients ignore the new fields. [beads:nx-vqnxe]

## UI Batch

- [ ] 3.1 Extend `apps/swift/NexusShared/Models/NotificationItem.swift` with optional `audioAvailable: Bool?`, `voiceUsed: String?`. Both nullable for back-compat. Add a Codable round-trip test for old (no fields) and new (both populated) payloads in `NexusSharedTests`. [beads:nx-1up8o]
- [ ] 3.2 Extend `apps/swift/NexusShared/Networking/NexusClient.swift` with `streamNotificationAudio(id:) -> AsyncThrowingStream<Data, Error>` (range-friendly), `fetchProjectVoices()` -> `[String: String]`, `putProjectVoice(project:voiceId:)`, `deleteProjectVoice(project:)`. Add same to `NexusAggregateClient.swift` via existing fan-out. **Conflict: shared file with 5 prior specs; wave-plan-build serializes.** [beads:nx-ka1br]
- [ ] 3.3 In `apps/swift/NexusShared/Observers/TTSObserver.swift`, add a `projectVoiceCache: [String: String]` actor-isolated map. Populate on startup via `fetchProjectVoices`. Subscribe to `VoiceOverrideChanged` on the existing notifications SSE stream — on event, refresh the cache. Update the voice-resolution chain at synthesise time: cache lookup → Keychain global → fallback. [beads:nx-2ae5p]
- [ ] 3.4 Add SSE event type `VoiceOverrideChanged { project: String }` to the notifications SSE consumer in `NexusClient` (whichever stream subscriber exists). Surface via existing event-handler protocol. [beads:nx-vjds8]
- [ ] 3.5 In `apps/swift/nexus-mac/Sources/Dashboard/NotificationsView.swift`, add a `@State private var sortMode: SortMode` enum (`time` / `project` / `session`) with `@AppStorage("notifications.sort")` backing. Apply a computed `sortedNotifications` based on the mode. Mode is a header `Picker(.segmented)` with three labels. [beads:nx-72ay6]
- [ ] 3.6 Add a "Group" toggle to the NotificationsView header — visible only when sortMode is `.project` or `.session`. When ON, render rows inside `DisclosureGroup` sections keyed by the group field. Misc (nil) group sorts last. [beads:nx-nurnp]
- [ ] 3.7 Add `apps/swift/nexus-mac/Sources/Dashboard/NotificationReplayButton.swift` — view taking `(notificationId: String, audioAvailable: Bool)` + an injected `MP3Player` reference. Tap streams `NexusClient.streamNotificationAudio` into the player. Show stop icon during playback. Cancel-on-disappear via `.task` cancellation. [beads:nx-tqv3b]
- [ ] 3.8 Mount `NotificationReplayButton` inside the notification row component when `audioAvailable == true`. Hide entirely when false. [beads:nx-xp96s]
- [ ] 3.9 Add `apps/swift/nexus-mac/Sources/Dashboard/ElevenLabsStatusChip.swift` — header chip with three states (`keySet` / `noKey` / `keyInvalid`). Popover on tap: masked-show of current Keychain value, paste field, Test button (calls `ElevenLabsClient.synthesize` with global voice), Save button (writes to Keychain). State driven by a shared `@Published ElevenLabsKeyState` published by TTSObserver (e.g. when a synth call returns 401, observer flips state to `.keyInvalid`). [beads:nx-iqvhw]
- [ ] 3.10 Mount `ElevenLabsStatusChip` inside the NotificationsView header. Wire to the shared observer state. [beads:nx-vnzdd]
- [ ] 3.11 Add `apps/swift/nexus-mac/Sources/Dashboard/ProjectVoicesView.swift` — list editor with rows (project, voiceId text field, Test button, delete icon) and an "Add project" affordance at the bottom. Save → PUT; delete → DELETE. Local state optimistic; reconcile against server response. Test button synthesises a sample line using the entered voiceId. [beads:nx-bmw0d]
- [ ] 3.12 Mount `ProjectVoicesView` inside the existing `apps/swift/nexus-mac/Sources/ElevenLabsSettingsView.swift` (or alongside it in the Settings tab — whichever the existing layout prefers). The single-global-voice field stays for back-compat as the fallback when no per-project override matches. [beads:nx-jro18]
- [ ] 3.13 Add `apps/swift/nexus-mac/Sources/Dashboard/NotificationsViewTests.swift` covering: sort-mode persistence across launch, group-toggle visibility logic, Misc-bucket last-position, replay button visibility logic. [beads:nx-f8bp4]
- [ ] 3.14 Add `apps/swift/nexus-mac/Sources/Dashboard/ProjectVoicesViewTests.swift` covering: add row PUT, delete row DELETE-204, test-button calls ElevenLabsClient with the right voice id, optimistic-then-rollback on error. [beads:nx-r0lj6]

## E2E Batch

- [ ] 4.1 End-to-end: trigger a TTS-eligible notification, wait for synthesis, curl `GET /notifications/<id>/audio`, assert response 200 with `Content-Type: audio/mpeg` and non-empty body. Confirm `audio_path` is set in the DB row. [beads:nx-s3uj7]
- [ ] 4.2 End-to-end: curl `PUT /notifications/voices/nx { voice_id: "voice-XYZ" }`, then `GET /notifications/voices`, assert the new override appears. Trigger a notification with `project: "nx"`, assert `voiceUsed: "voice-XYZ"` in the row. [beads:nx-ldhf6]
- [ ] 4.3 End-to-end: subscribe to `/notifications/events` SSE in a test client, issue `PUT /notifications/voices/oo`, assert `VoiceOverrideChanged { project: "oo" }` arrives within 2 seconds. [beads:nx-q9me4]
- [ ] 4.4 [user] Open Nexus.app Notifications tab. Confirm: (a) sort picker switches between Time / Project / Session; (b) Group toggle collapses by section in Project/Session modes; (c) replay button plays cached audio; (d) ElevenLabs chip popover opens and Test button works; (e) Settings → ProjectVoicesView add/edit/delete round-trips correctly. [beads:nx-3grg9]
