# Change: Notification fidelity — working banner toggle, grant diagnosis, project-and-session titles

## Why
Two notification quality-of-life defects, found during the 2026-06-18 Serval QoL exploration:

1. The macOS "Show notification banner" toggle is a **dead control** — it persists to
   `nx.notifications.bannerEnabled` but no posting/presentation code reads it, so flipping it
   does nothing. Banners are gated solely by the macOS OS grant, which was silently reset to
   alert-style "None" by the Jun-14 re-sign (`codesign` Signed Time confirms; the usernoted db2
   `delivered` blob is non-empty, proving banners deliver to Notification Center but never
   present). The user has no in-app lever and no diagnosis path.
2. Notification titles surface only ONE of project-code / session-name. The agent's `title()`
   helper picks via `a || b || c`, so a session name hides the project and vice-versa. Both
   fields already flow end-to-end; only the formatter discards one.

## What Changes
- **Banner toggle becomes functional.** `TTSObserver.postBanner` and
  `SessionObserver.postLocalNotification` gate on `nx.notifications.bannerEnabled` (default
  `true`); `NotificationActivationHandler.willPresent` honors the same flag as a foreground
  defense-in-depth gate. **BREAKING (behavioral):** turning the toggle off now genuinely
  suppresses banners — today it is a no-op, so anyone who left it off expecting banners will
  see them disappear. (Default stays on; only an explicit-off user is affected.)
- **macOS grant becomes diagnosable.** Add a `getNotificationSettings` re-check at app launch
  (`nexusApp.swift:109`) logging `authorizationStatus` + `alertStyle`, so a reset grant shows
  in the launch trace instead of failing silently. (Re-granting itself stays a System Settings
  action — the OS will not re-prompt after a denial.)
- **Titles compose `project · session` across all three surfaces** (iOS APNS push, macOS
  desktop banner, iOS in-app notification list), middot-separated, degrading gracefully to
  session-only, then project-only, then the raw title. One rule, expressed once in the agent
  (server-built APNS push) and once in Swift (client-built banner + in-app list).

## Impact
- Affected specs: `notification-store` (title composition), `nexus-shared-framework` (banner
  toggle gating in NexusShared observers), `swift-menubar-client` (macOS grant re-check log).
- Affected code:
  - `apps/agent/src/health-push/notification-push.ts:128` — `title()` composition
  - `apps/swift/NexusShared/Observers/TTSObserver.swift:523` — banner gate + banner title
  - `apps/swift/NexusShared/Observers/SessionObserver.swift:178` — banner gate
  - `apps/swift/nexus-mac/Sources/NotificationActivationHandler.swift:87` — willPresent gate
  - `apps/swift/nexus/nexus/nexusApp.swift:109` — grant re-check log
  - `apps/swift/NexusShared/Models/Notification.swift:85` — shared `displayTitle` composition
  - `apps/swift/nexus-ios/Sources/Scenes/NotificationDetailScene.swift` — in-app list title

## Context
- depends on: none
- touches: `apps/agent/src/health-push/notification-push.ts`, `apps/swift/NexusShared/Observers/TTSObserver.swift`, `apps/swift/NexusShared/Observers/SessionObserver.swift`, `apps/swift/nexus-mac/Sources/NotificationActivationHandler.swift`, `apps/swift/nexus/nexus/nexusApp.swift`, `apps/swift/NexusShared/Models/Notification.swift`, `apps/swift/nexus-ios/Sources/Scenes/NotificationDetailScene.swift`
