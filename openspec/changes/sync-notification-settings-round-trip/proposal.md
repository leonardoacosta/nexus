---
order: 0720a
---

# Proposal: Sync Notification Settings Round-Trip

## Change ID
`sync-notification-settings-round-trip`

## Summary
Close the settings-sync gap between the Mac Settings panes and the agent: `SettingsTtsView`
writes toggles to UserDefaults only (never PATCHes the server), `NotificationsView.persist()`
already PATCHes but with field names that don't exist server-side (every call 400s silently),
and `TTSObserver` never subscribes to `SettingsChanged` so a settings change made elsewhere is
never picked up live.

## Context
- Extends: `apps/swift/nexus-mac/Sources/Dashboard/Settings/SettingsTtsView.swift`,
  `apps/swift/nexus-mac/Sources/Dashboard/NotificationsView.swift`,
  `apps/swift/NexusShared/Observers/TTSObserver.swift`,
  `apps/agent/src/routes/notification-settings.ts`,
  `packages/db/src/schema/notificationSettings.ts`
- Related: `context-aware-routing` (archived) — `SettingsRoutingView` is this proposal's reference
  implementation for the correct PATCH + re-read pattern; `add-notification-control-dashboard`
  (archived) — introduced the `/notifications/settings` endpoint this proposal extends.
- touches: `packages/db/src/schema/notificationSettings.ts`, `apps/agent/src/routes/notification-settings.ts`, `apps/agent/src/routes/notification-settings.test.ts`, `apps/swift/nexus-mac/Sources/Dashboard/Settings/SettingsTtsView.swift`, `apps/swift/nexus-mac/Sources/Dashboard/NotificationsView.swift`, `apps/swift/NexusShared/Observers/TTSObserver.swift`, `apps/swift/NexusShared/Storage/SettingsStore.swift`, `apps/swift/NexusShared/Networking/NexusClient.swift`, `apps/swift/nexus-mac/Tests/SettingsTtsViewTests.swift`

## Motivation

An `/explore` session (2026-07-20) traced the full Settings surface against the server and found
three distinct defects, all in the same PATCH/SSE seam `SettingsRoutingView` already gets right:

1. **`SettingsTtsView.persistToggles()`** writes `ttsEnabled`/`banner`/`ducking` to UserDefaults
   only. All three already have DB columns (`tts_enabled`, `banner_enabled`, `ducking_mode`) and
   allow-list entries in `notification-settings.ts`, and `NexusClient.patchNotificationSettings()`
   already exists — the view just never calls it. It "works" today only because the view and the
   listener run in the same macOS process; the design nx is built on (peer-to-peer over
   Tailscale, agent per machine) means another machine's listener, or this listener after an
   agent restart, would never see the change.

2. **`NotificationsView.persist()`** already calls `client.patchNotificationSettings(["meetingMode":
   ..., "signalOnly": ..., "suppressionMinutes": ...])` — but none of those camelCase keys are in
   the server's `ALLOWED_KEYS` set (snake_case only), and none of the three even exist as DB
   columns. Every call 400s server-side; the result is discarded with no error handling, and the
   UI still flashes "Saved". This is a silent-failure-masquerading-as-success bug, worse than a
   missing call.

3. **`TTSObserver`** reads its gating state from `SettingsStore`/UserDefaults and subscribes to
   `NotificationFired`/`VoiceOverrideChanged`, but never `SettingsChanged` — even though the agent
   already broadcasts that event on every successful PATCH (`notification-settings.ts:425-429`,
   per its own header comment: "so SSE subscribers (the Mac listener) can update their cached
   toggles without polling"). The documented design in `deploy/README.md` already describes this
   exact round trip; it was never implemented on the listener side.

**Design decision (Leo, confirmed 2026-07-20 via `/explore`'s scaffold-offer question):**
`signal_only`, `meeting_mode`, and `suppression_minutes` are real synced settings, not
local-only preferences — each gets a real DB column + migration, completing the intent
`NotificationsView`'s existing (broken) PATCH call already signals. The listener learns about
remote changes via a live `SettingsChanged` SSE subscription (matching the documented design),
not polling.

## Requirements

### Requirement: Notification settings schema covers every client-exposed toggle
`notification_settings` gains three columns — `signal_only` (boolean, default false),
`meeting_mode` (boolean, default false), `suppression_minutes` (integer, default 0) — and the
agent's PATCH allow-list is extended to accept `signal_only`, `meeting_mode`,
`suppression_minutes` in addition to the existing keys.

### Requirement: SettingsTtsView persists toggles to the server
Toggling TTS enabled, banner, ducking mode, or signal-only in `SettingsTtsView` calls
`NexusClient.patchNotificationSettings()` with the correct snake_case keys, following
`SettingsRoutingView`'s existing pattern (persist to `SettingsStore` locally, then PATCH; flash a
save/error status).

### Requirement: NotificationsView's settings PATCH uses real, existing fields
`NotificationsView.persist()`'s PATCH body uses the snake_case keys the server actually accepts
(`meeting_mode`, `signal_only`, `suppression_minutes`), and a failed PATCH surfaces a visible error
state instead of silently showing "Saved".

### Requirement: TTSObserver observes remote settings changes
`TTSObserver` subscribes to the `SettingsChanged` SSE event and updates its cached gating state
(ttsEnabled, banner, ducking, signalOnly) when a change arrives from another process or machine,
without requiring an app restart.

## Scope
- **IN**: `signal_only`/`meeting_mode`/`suppression_minutes` DB columns + allow-list; wiring
  `SettingsTtsView`'s PATCH call; fixing `NotificationsView`'s PATCH field names + error surfacing;
  `TTSObserver`'s `SettingsChanged` subscription.
- **OUT**: presence-aware routing, routing rules, and bedtime-source settings — already correctly
  implemented by `SettingsRoutingView` (no gap found, verified during `/explore`). Any other
  Settings pane's purely local-only preferences (e.g. `SettingsNotificationsView`'s sort order /
  replay autoplay) — no cross-machine meaning, out of scope by design.

## Done Means
- Toggling TTS/banner/ducking/signal-only in Settings > TTS & Audio persists to the server and is
  visible from another machine's dashboard (or survives an agent restart) without an app restart.
- Toggling meeting-mode/signal-only/suppression in the Notifications drawer actually saves
  server-side (verifiable via `GET /notifications/settings`), and a failed save shows a real error
  instead of a false "Saved".
- A settings change made in one Settings pane, or applied directly to the DB row, is reflected in
  `TTSObserver`'s live gating behavior without an app restart.

## Testing
| Affected seam | Unit task | E2E task |
|----------------|-----------|----------|
| `notification-settings.ts` PATCH allow-list + schema | [1.2] | N/A — no user-facing flow (server route, covered by existing route test suite pattern) |
| `SettingsTtsView.persistToggles()` | [3.1] | N/A — no Playwright/XCUITest harness for nexus-mac Settings panes today |
| `NotificationsView.persist()` | [3.2] | N/A — same as above |
| `TTSObserver` SettingsChanged subscription | [3.3] | N/A — same as above |

## Impact
| Area | Change |
|------|--------|
| `packages/db/src/schema/notificationSettings.ts` | +3 columns, +1 migration |
| `apps/agent/src/routes/notification-settings.ts` | +3 allow-list keys, response type extended |
| `apps/swift/nexus-mac/Sources/Dashboard/Settings/SettingsTtsView.swift` | Calls PATCH on toggle change |
| `apps/swift/nexus-mac/Sources/Dashboard/NotificationsView.swift` | PATCH body field names fixed, error surfaced |
| `apps/swift/NexusShared/Observers/TTSObserver.swift` | New SettingsChanged SSE subscription |
| `apps/swift/NexusShared/Storage/SettingsStore.swift` | New `signalOnly`/`meetingMode`/`suppressionMinutes`-from-server overlay, if not already covered |

## Risks
| Risk | Mitigation |
|------|-----------|
| New DB columns need a migration on the shared homelab Postgres instance | Migration-based only (`db:generate` + deploy `db:migrate`), never `db:push` — per project convention |
| `SettingsChanged` subscription could race a local optimistic UserDefaults write | Follow `SettingsRoutingView`'s existing pattern: local write happens first, then PATCH; incoming `SettingsChanged` always wins as the source of truth on conflict (last-write-wins is already the server's behavior) |
| NotificationsView's silent-failure bug has shipped for some time — fixing error surfacing changes user-visible behavior | Acceptable and intended: showing a real failure state is the fix, not a regression |
