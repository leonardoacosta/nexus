---
order: 0724e
---

# Proposal: Fix Four Swift TTS/Notification Defects from the 2026-07-24 Audit

## Change ID
`fix-swift-tts-audit-defects`

> Advisor stamp: 2026-07-24 `/improve` run against commit `9e4963b9`. Verify cited lines before starting; STOP on drift.

## Summary
Four small, vetted defects in the Swift suite, all in recently-churned TTS/notification code, bundled because they share files, tests, and one xcodegen regeneration: (1) a force-unwrapped `URL(string:)!` on the ElevenLabs synth path traps on a malformed config-driven voice id instead of degrading; (2) the NotificationDrawer TTS quick-toggle writes local-only `@AppStorage` and never PATCHes the agent, violating the settings round-trip its sibling toggles honor; (3) `TTSObserver.cancelHandler` strongly captures its own `NowPlayingController`, a retain cycle its sibling handlers avoid with `[weak nowPlaying]`; (4) `AudioPlayer.play(mp3Data:)` supersedes a manual replay without clearing `currentlyPlayingId`, desyncing the replay row's stop button from what is audibly playing.

## Context
- depends on:
- touches: `apps/swift/NexusShared/Synthesis/ElevenLabsClient.swift`, `apps/swift/NexusShared/Observers/TTSObserver.swift`, `apps/swift/nexus-mac/Sources/Dashboard/NotificationDrawer.swift`, `apps/swift/nexus-mac/Sources/AudioPlayer.swift`, `apps/swift/NexusSharedTests/TTSObserverProviderChainTests.swift`, `apps/swift/nexus-mac/Tests/NotificationReplayButtonTests.swift`, `apps/swift/project.yml`

## Motivation
All four were found by the 2026-07-24 advisor audit auditing post-7/19 churn (swift-tts-provider-chain, provider-qualified-project-voices, fix-notification-replay-stop-button waves). Evidence, verified at base:
- `ElevenLabsClient.swift:47`: `URL(string: "https://api.elevenlabs.io/v1/text-to-speech/\(request.voiceId)")!` — voiceId flows unvalidated from `parseQualifiedVoice` on a project override; a space yields nil and the `!` traps. Every other failure in the chain throws so `walkProviderChain` can advance; only this one crashes.
- `NotificationDrawer.swift:21,80`: `@AppStorage("nx.tts.enabled")` bound straight to `DrawerToggle` — the adjacent Meeting-mode toggle persists via `model.persist()`, and `SettingsTtsView.persistToggles()` (SettingsTtsView.swift:87,98) PATCHes `tts_enabled`. The drawer toggle silently loses to the next inbound `SettingsChanged` reconciliation.
- `TTSObserver.swift:157-166`: `nowPlaying.cancelHandler = { … controller.noteClipEnded() … }` where `controller` is `nowPlaying` — a stored-closure retain cycle; siblings at :185/:195 use `[weak nowPlaying]`.
- `AudioPlayer.swift:93-112`: `play(mp3Data:)` calls `restoreSystemVolume()` for supersede handling but never clears `currentlyPlayingId` (set by the id-taking replay path at :85-88); the stale id leaves the wrong row showing `stop.circle` and stop stops the wrong clip.

## Testing
- Malformed voice id (`"elevenlabs voice with spaces"`) throws (new `ElevenLabsError` case) rather than trapping — new case in `TTSObserverProviderChainTests.swift`-style unit tests; chain advances to next provider.
- Drawer TTS toggle emits the settings PATCH — extend the round-trip coverage added by `sync-notification-settings-round-trip` (exemplars: `SettingsTtsViewTests`, the PATCH/SSE round-trip tests).
- Replay supersede: id-play then data-play ⇒ `currentlyPlayingId == nil` — new case beside `NotificationReplayButtonTests.swift`.
- Retain cycle: capture-list change verified by review (no strong capture of the controller in its own stored handler); no runtime test required.
- Gate: `xcodebuild -scheme nexus-mac test -only-testing:nexus-mac-Tests -only-testing:NexusSharedTests` (or the repo's ssh-mac `swiftc -typecheck` contract when no Mac runner is available in-session).

## Done Means
- A malformed project voice override degrades to the next TTS provider; the app does not crash.
- Toggling TTS in the drawer persists to the agent and survives an inbound `SettingsChanged`, observably equivalent to the SettingsTtsView toggle.
- A live TTS clip superseding a manual replay reverts the replay row's icon to play; stop never stops an unrelated clip.
- `NowPlayingController` deallocates when its observer does (no cycle).

## Scope
- **IN**: the four fixes above, their tests, `project.yml`/xcodegen registration for any new test file (precedent: commit `9c1013b9`).
- **OUT**: voice-id write-time validation (agent-side, already length/provider-checked); other force-unwraps outside this path; `NowPlayingController` internals; ducking logic; watchOS/iOS targets.
