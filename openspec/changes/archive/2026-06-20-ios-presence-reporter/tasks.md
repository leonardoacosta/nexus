<!-- beads:epic:nx-i4sp1 -->
<!-- beads:feature:nx-37834 -->

# Tasks — iOS Presence Reporter (Phase 2)

## DB Batch

- [x] Add `bedtime_sources` column to `packages/db/src/schema/notificationSettings.ts` (text `$type<"hk"|"focus"|"either"|"both">()` notNull default `"either"`); keep existing columns [beads:nx-ha2yq]
- [x] `pnpm --filter @nexus/db db:generate` (creates the migration `.sql`), verify it is additive (ADD COLUMN, no drops), then deploy applies via `db:migrate` — NEVER `db:push`. Handle the snapshot guard if it trips; paste the generated SQL + snapshot-guard result [beads:nx-bmuwj]

## API Batch

- [x] Add `phoneFocusOn` to `PresenceVector` in `packages/core/src/types/presence.ts` (TTL'd `PresenceField<boolean>`; `isBedtime` already exists) [beads:nx-rxyjq]
- [x] Extend `apps/agent/src/routes/presence-report.ts` to accept the phone signals (`hkSleepWindow`, `sleepFocusActive`, `phoneFocusOn`) keyed by the phone machine; validate shape, 400 on bad input [beads:nx-1gf42]
- [x] Add `applyBedtimeSources(setting, { hkSleepWindow, sleepFocusActive })` (a pure function) and compute `isBedtime` per the `bedtime_sources` setting (`hk|focus|either|both`); store the phone signals + computed `isBedtime` + `phoneFocusOn` in a GLOBAL phone record in `apps/agent/src/notifications/presence-context.ts` [beads:nx-8c1c3]
- [x] Add `overlayGlobalPhoneFields(vector)` (in `fleet-presence.ts` or presence-context) that overlays the freshest global `isBedtime`/`phoneFocusOn` onto a resolved eval vector; a phone field past TTL reads `unknown` (no override). Wire it into `apps/agent/src/notifications/manager.ts` after `resolveLiveConsoleVector`, before `decidePresenceRoute` [beads:nx-h1rf7]
- [x] Add Rule 3 to `apps/agent/src/notifications/rules-engine.ts`: `isBedtime AND NOT macActive` → `{ banner, ding:false, tts:false, deliverTo:["phone"], interruptionLevel:"passive" }`; insert AFTER Rule 2, BEFORE Rule 4; active Mac (Rule 1) still wins [beads:nx-x5rdv]
- [x] Add the Focus-respect modifier in `rules-engine.ts` (or the manager): when `phoneFocusOn` is known-true and the matched action is non-critical, drop `interruptionLevel` to `passive`; channels unchanged [beads:nx-xe9vh]
- [x] Extend `apps/agent/src/routes/notification-settings.ts` to accept + validate `bedtime_sources` (enum), broadcasting `SettingsChanged` [beads:nx-xgtgj]

## UI Batch

- [x] Add `com.apple.developer.usernotifications.communication` to `apps/swift/nexus-ios/Resources/nexus-ios.entitlements` (portal capability already granted; this is the matching local key) [beads:nx-wf4s1]
- [x] Create `apps/swift/nexus-ios/Sources/App/PresenceReporter.swift` — reads HK sleep schedule (in-window-now, reusing `HealthKitPushManager`'s `.sleepAnalysis`/observer), `INFocusStatusCenter` (Focus + Sleep-Focus) with authorization request, and POSTs `{ machine, hkSleepWindow, sleepFocusActive, phoneFocusOn }` to the agent via `NexusShared.NexusClient`; event-driven (HK observer + Focus-change + foreground), no polling [beads:nx-eqsz9]
- [x] Wire the reporter into `apps/swift/nexus-ios/Sources/App/NexusAppDelegate.swift` (start on launch + foreground; subscribe to Focus-status changes) — NOTE: shared file with `ios-session-navigation`, edit surgically [beads:nx-rkv01]
- [x] Add a `reportPresence`/presence client method to `apps/swift/NexusShared/Networking/NexusClient.swift` if not already present for iOS (qualify `NexusShared.NexusClient`) — NOTE: shared file with `ios-session-navigation` [beads:nx-e48bb] (existing `reportPresence(_:)` reused; added `bedtime_sources` decode to `NotificationSettingsResponse`)
- [x] Add a bedtime-sources control (HK / Focus / either / both) to `apps/swift/nexus-mac/Sources/Dashboard/Settings/SettingsRoutingView.swift`, persisted via the existing settings PATCH path [beads:nx-7hp9i]

## E2E Batch

- [x] Extend `apps/agent/src/routes/presence-report.test.ts` — phone signals parse + key into the global phone record; bad shape 400; missing machine handled [beads:nx-1eqyz]
- [x] Extend `apps/agent/src/notifications/rules-engine.test.ts` — Rule 3 (bedtime+idle Mac → silent passive phone; active Mac beats it; ordering after Rule 2 before Rule 4); Focus-respect modifier drops non-critical to passive; `applyBedtimeSources` for hk/focus/either/both [beads:nx-nja0z]
- [x] Extend `apps/agent/src/routes/notification-settings.test.ts` — `bedtime_sources` accepted + validated + broadcast; bad enum rejected; plus a no-regression test (phone fields unknown → overlay no-op → Phase 1.7 behavior unchanged) [beads:nx-9aspc]
- [x] Create `apps/swift/nexus-ios/Tests/PresenceReporterTests.swift` — the reporter's pure logic: in-window computation from a sleep schedule fixture, Focus-on → phoneFocusOn, builds the correct report payload [beads:nx-xm1bn]
