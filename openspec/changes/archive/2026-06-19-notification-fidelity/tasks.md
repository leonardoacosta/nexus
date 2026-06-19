<!-- beads:epic:nx-09shh -->
<!-- beads:feature:nx-nu2pf -->

# Tasks: notification-fidelity

## DB Batch

_No database changes — notification payloads already carry `project`, `sessionName`, `sessionId`._

## API Batch

- [x] 1.1 Add `composeTitle(project?, session?, fallback?)` helper in the agent push module (next to `title()` in `apps/agent/src/health-push/notification-push.ts`). Rule: `project && session -> "${project} · ${session}"`, else `session || project || fallback || "Nexus"`. Trim inputs; treat empty/whitespace as absent. [owner:api-engineer] [beads:nx-r5amo]
- [x] 1.2 Replace the `a || b || c` chain in `title()` (`notification-push.ts:128`) with a call to `composeTitle(p.project, p.sessionName, p.title)`. Confirm the body computation (`p.body || p.message || title`, ~:83) still reads sensibly with the new longer title. [owner:api-engineer] [beads:nx-yxsc0]
- [x] 1.3 Add a bun unit test asserting all four cases of `composeTitle`: both present (`oo · fix-login-flow`), session-only, project-only, neither (`Nexus`). This is the runtime evidence for the title rule until APNS provisioning (`nx-gsgvk`) lands. [owner:test-writer] [beads:nx-3grhw]

## UI Batch

- [x] 2.1 Add a `displayTitle` computed property to `NotificationEvent` in `apps/swift/NexusShared/Models/Notification.swift` (~:85): same fallback ladder as `composeTitle` — `project · session`, else session, else project, else `title`. First verify `NotificationEvent` carries `project`; if not, plumb it from the payload before adding the property. [owner:swift-engineer] [beads:nx-yrvh6]
- [x] 2.2 macOS banner: in `TTSObserver.postBanner` (`apps/swift/NexusShared/Observers/TTSObserver.swift:523`), set the banner content title from `event.displayTitle` instead of `event.title`. [owner:swift-engineer] [beads:nx-qrrjl]
- [x] 2.3 Banner gate (TTS poster): at the top of `TTSObserver.postBanner`, early-return when `UserDefaults.standard.object(forKey: "nx.notifications.bannerEnabled") as? Bool ?? true` is `false`. Match the raw-UserDefaults precedent at `TTSObserver.swift:653-661`. Do NOT gate the audio/TTS stage. [owner:swift-engineer] [beads:nx-7ftqf]
- [x] 2.4 Banner gate (session poster): apply the same early-return guard in `SessionObserver.postLocalNotification` (`apps/swift/NexusShared/Observers/SessionObserver.swift:178`). [owner:swift-engineer] [beads:nx-yi60u]
- [x] 2.5 Foreground gate: in `NotificationActivationHandler.willPresent` (`apps/swift/nexus-mac/Sources/NotificationActivationHandler.swift:87`), return `[]` (no banner/sound presentation) when the toggle is off, as defense-in-depth for any already-posted request. [owner:swift-engineer] [beads:nx-57hnd]
- [x] 2.6 iOS in-app list: update `NotificationDetailScene` (`apps/swift/nexus-ios/Sources/Scenes/NotificationDetailScene.swift`) title row to render `event.displayTitle`. [owner:swift-engineer] [beads:nx-bhs9t]
- [x] 2.7 macOS grant re-check: after `requestAuthorization` in `apps/swift/nexus/nexus/nexusApp.swift:109-121`, call `getNotificationSettings` and log `authorizationStatus` + `alertStyle` via the app logger. Log-only — no re-prompt, no UI. [owner:swift-engineer] [beads:nx-c5si9]

## E2E Batch

- [x] 3.1 Swift test (or a documented manual check) asserting `NotificationEvent.displayTitle` returns `oo · fix-login-flow` for both-present and degrades correctly for the three fallback cases — keeping the Swift rule in lockstep with the bun test in 1.3. [owner:swift-engineer] [beads:nx-j9v6h]
- [x] 3.2 Verified on-device 2026-06-18: toggle ON -> banner posts with `displayTitle` (showed `oo`, project fallback); toggle OFF -> banner suppressed (Leo confirmed). Grant re-granted in System Settings (Jun-14 re-sign had reset it). Middot `project · session` covered by unit tests (composeTitle 7 pass, displayTitle 6 pass) — renders on real session notifications. [owner:user] [beads:nx-0pk9c]
