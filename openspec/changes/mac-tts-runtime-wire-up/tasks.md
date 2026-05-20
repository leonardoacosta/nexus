# Tasks: mac-tts-runtime-wire-up

<!-- beads:epic:nx-ga815 -->
<!-- beads:feature:nx-kk2qa -->

## API Batch

- [x] [1.1] Add `SystemSpeechSynthesizer` wrapper in `apps/swift/NexusShared/Synthesis/SystemSpeechSynthesizer.swift` — thin AVSpeechSynthesizer adapter with `speak(_ text: String, rate:)` method [owner:ui-engineer] [type:feature] [beads:nx-wy3i8]
- [x] [1.2] Add `TTSObserver` class in `apps/swift/NexusShared/Observers/TTSObserver.swift` with `start() async` + `stop()` API, dependency-injected ElevenLabsClient + SystemSpeechSynthesizer + AudioPlayer + KeychainStore [owner:ui-engineer] [type:feature] [beads:nx-9dkr8]
- [x] [1.3] [P-1] TTSObserver receives NotificationFired via `consumeNotifications`, filters channel=="tts", posts UNUserNotificationCenter banner BEFORE synth attempt [owner:ui-engineer] [type:feature] [beads:nx-hdriz]
- [x] [1.4] [P-1] TTSObserver synth chain: try ElevenLabs (Keychain key, HTTP) -> fallback to SystemSpeechSynthesizer on any error; pipe ElevenLabs mp3 to AudioPlayer.shared.play with ducking from settings [owner:ui-engineer] [type:feature] [beads:nx-n7a8d]
- [ ] [1.5] TTSObserver os_log instrumentation at every pipeline stage (received, filtered, banner, synth-start, synth-result, playback) with `%{public}@` formatters [owner:ui-engineer] [type:feature] [beads:nx-47pfz]

## UI Batch

- [ ] [2.1] Modify `apps/swift/nexus-mac/Sources/nexusApp.swift` to instantiate TTSObserver as `@StateObject` in `init()`, request UNUserNotificationCenter authorization with `[.alert, .sound]` options [owner:ui-engineer] [type:feature] [beads:nx-vwo75]
- [ ] [2.2] Start TTSObserver subscription in `init()` via `Task { @MainActor in await observer.start() }` so subscription runs window-independently [owner:ui-engineer] [type:feature] [beads:nx-2c55p]
- [ ] [2.3] [P-2] Update `apps/swift/project.yml` to ensure `UserNotifications.framework` is linked to the `nexus-mac` target (verify with `xcodebuild -showBuildSettings`) [owner:ui-engineer] [type:feature] [beads:nx-asibz]
- [ ] [2.4] [P-2] Verify Nexus.app entitlements include the notification capability via `codesign -d --entitlements - /Applications/Nexus.app` after `04-swift-deploy --force` rebuild [owner:devops-engineer] [type:test] [beads:nx-pmai9]

## E2E Batch

- [ ] [3.1] Add `apps/swift/NexusSharedTests/TTSObserverTests.swift` with 5 unit tests: testStartRegistersHandler, testStopCancelsSubscription, testNonTtsChannelIgnored, testElevenLabsFailureFallsBackToSystemSpeech, testBannerPostedRegardlessOfSynth [owner:ui-engineer] [type:test] [beads:nx-4bnv5]
- [ ] [3.2] Add `apps/swift/nexus-mac/Tests/TTSObserverIntegrationTest.swift` that builds a real TTSObserver against a stub-agent emitting one NotificationFired and asserts AudioPlayer (or AVSpeechSynthesizer mock) was invoked within 2s [owner:ui-engineer] [type:test] [beads:nx-wurjh]
- [ ] [3.3] Runtime smoke from Mac shell: `source ~/.env && source ~/.claude/scripts/lib/nx-send.sh && nx_notify "e2e smoke from mac-tts-runtime-wire-up"`. Capture Console.app `process:nexus` log output proving the full pipeline trace. Verify macOS banner appears with title "Nexus" within 2s [user] [owner:user] [type:test] [beads:nx-fy5r6]
- [ ] [3.4] Update `openspec/specs/mac-tts-listener/spec.md` post-archive with the new gate-enforced TTS observer requirements [handled by Phase 4 archive] [owner:devops-engineer] [type:docs] [beads:nx-peh21]
