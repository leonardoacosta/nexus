# Proposal: Wire Mac TTS runtime end-to-end

## Change ID

mac-tts-runtime-wire-up

## Why

The Mac TTS pipeline is structurally broken since the Bun listener was
decommissioned ~2026-05-16. `swift-owns-elevenlabs-synth` (approved
2026-05-17, 6/9 tasks `[x]`) shipped the building blocks — Keychain wrapper,
ElevenLabsClient, AudioPlayer, settings UI — but never wired them. No
NotificationFired observer exists in `apps/swift/nexus-mac/`, no
`UNUserNotificationCenter` setup, no permission request flow. The only call
site for `AudioPlayer.shared.play()` is the "test voice" button in
settings.

Verified runtime evidence 2026-05-19/20: homelab broadcasts
`NotificationFired` on `/events/stream` (curl confirmed), Nexus.app has 5
TCP sockets to homelab, the Notifications HISTORY sidebar consumes events
correctly — but no banner, no audio. The dispatch wire from SSE event to
AVAudioPlayer + macOS banner was never built. P0 bug `nx-smger`.

## What Changes

- Add `TTSObserver` class in `NexusShared/Observers/` that subscribes to
  `NexusClient.consumeNotifications`, synthesizes via `ElevenLabsClient`
  when Keychain key is present, falls back to `AVSpeechSynthesizer` when
  ElevenLabs fails (network, quota, missing key), pipes mp3 bytes to
  `AudioPlayer.shared.play`, AND posts a banner via
  `UNUserNotificationCenter.current().add`.
- Wire `TTSObserver` lifecycle at `@main App` init in `nexusApp.swift` so
  the observer runs **window-independently** (LSUIElement menu-bar apps
  must not depend on a SwiftUI view's `.task` to start network work).
- Request `UNUserNotificationCenter` authorization at app launch with
  `[.alert, .sound]` options. Add UserNotifications.framework to the
  nexus-mac target in project.yml.
- Unit test: TTSObserver registers a handler when `start()` is called.
- Runtime smoke test: from Mac shell, `nx_notify "test"`, observe banner +
  audio within 2s. Capture Console.app logs confirming each pipeline stage
  (`os_log` calls in TTSObserver for observability).

## Context

- depends on: `swift-owns-elevenlabs-synth`
- touches: `apps/swift/NexusShared/Observers/TTSObserver.swift`, `apps/swift/nexus-mac/Sources/nexusApp.swift`, `apps/swift/nexus-mac/Sources/AppNavigation.swift`, `apps/swift/project.yml`, `apps/swift/NexusSharedTests/TTSObserverTests.swift`, `apps/swift/NexusShared/Synthesis/SystemSpeechSynthesizer.swift`

## Motivation

Two failure modes drove this:

- **Operational**: TTS has been silently broken on Mac for ~3 days. Every
  `nx_notify` call from bash hooks dead-letters. The user (Leo) is missing
  meaningful work signals on every CC session.
- **Architectural**: `swift-owns-elevenlabs-synth` had per-class tasks
  (Keychain, AudioPlayer, ElevenLabsClient) but no integration task. The
  spec template needs to enforce a "runtime smoke test" task that proves
  end-to-end behavior, not just "class exists".

## Locked Decisions (from Phase 2 refinement)

- **Synthesis location**: Mac synthesizes on receipt. ELEVENLABS_API_KEY
  lives in Mac Keychain (already shipped by 1.1 of swift-owns-elevenlabs-synth).
  Agent emits text-only NotificationFired. Rejected: agent-side inlining
  (would require homelab to hold a per-user TTS key).
- **Fallback**: AVSpeechSynthesizer when ElevenLabs unavailable. TTS NEVER
  silently fails. Native macOS voice is the safety net. Banner still posts.
- **Permission timing**: At `@main App` init. User sees system prompt on
  first launch. Banners work from first notification onward. Rejected: lazy
  request on first event (race condition risks missing the first banner).
- **Logging**: `os_log` at every pipeline stage so Console.app is the
  single-pane diagnostic surface. Mirrors the gap exposed by `nx-8e81d`
  (zero observability inside Swift).

## Out of Scope

- Voice configuration per project (already shipped via Settings UI in
  swift-owns-elevenlabs-synth task 1.4).
- Banner-click cancel (landed natively in Swift per
  P4.7 `remove-notification-channels`).
- iOS / watchOS TTS — separate targets, separate observers.
- Telemetry on TTS success/failure rates — future analytics, not part of
  the wire-up itself.
