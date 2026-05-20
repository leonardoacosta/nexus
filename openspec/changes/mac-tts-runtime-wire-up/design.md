# Design: Mac TTS runtime wire-up

## Observer Architecture

```
NexusShared
├── Observers/
│   └── TTSObserver.swift          [NEW]
├── Synthesis/
│   ├── ElevenLabsClient.swift     [exists — swift-owns-elevenlabs-synth]
│   └── SystemSpeechSynthesizer.swift [NEW — AVSpeechSynthesizer wrapper]
└── (Storage/, Networking/, Models/) — exists

apps/swift/nexus-mac/
├── Sources/
│   ├── nexusApp.swift             [MODIFIED — @main App init wires observer + UN]
│   ├── AudioPlayer.swift           [exists — only call site adds TTSObserver]
│   └── AppNavigation.swift        [MODIFIED — keep observer instance @State]
└── (Dashboard/, Settings/, ...) — exists
```

### TTSObserver Contract

```swift
@MainActor
public final class TTSObserver: ObservableObject {
    public init(
        client: NexusAggregateClient,
        keychain: KeychainStore,
        audioPlayer: AudioPlayer = .shared,
        systemSpeech: SystemSpeechSynthesizer = .init(),
        elevenLabs: ElevenLabsClient = .init()
    )

    /// Subscribe to NotificationFired SSE. Window-independent — call from
    /// @main App init. Returns when cancelled; agent client owns retry.
    public func start() async

    /// Cancel the subscription. Idempotent.
    public func stop()
}
```

Internal flow on each `NotificationFired`:

```
1. Decode NotificationEvent from SSE frame
2. os_log("TTSObserver: received id=%{public}@ channel=%{public}@", id, channel)
3. If channel != "tts" → return early (let other observers handle)
4. Post banner via UNUserNotificationCenter.current().add(UNNotificationRequest(
     identifier: id, content: <title, body>, trigger: nil
   ))
5. os_log("TTSObserver: banner posted id=%{public}@", id)
6. Attempt synth: try await elevenLabs.synthesize(text: body, voice: settings.voiceId)
   ├─ Success → AudioPlayer.shared.play(mp3Data: data, ducking: settings.ducking)
   │            os_log("TTSObserver: elevenlabs played %d bytes", data.count)
   └─ Failure → systemSpeech.speak(text: body)
                os_log("TTSObserver: fallback to AVSpeechSynthesizer (reason: %{public}@)", reason)
```

### SystemSpeechSynthesizer

Thin AVSpeechSynthesizer wrapper. NOT a swift-singleton (AVSpeechSynthesizer
has its own delegate lifecycle). Plays directly via OS audio path — does NOT
route through AudioPlayer. Ducking is best-effort via AVAudioSession on iOS,
no-op on macOS.

```swift
@MainActor
public final class SystemSpeechSynthesizer {
    private let synth = AVSpeechSynthesizer()
    public func speak(_ text: String, rate: Float = AVSpeechUtteranceDefaultSpeechRate) {
        let utterance = AVSpeechUtterance(string: text)
        utterance.rate = rate
        synth.speak(utterance)
    }
}
```

## @main App Init Wiring

`nexusApp.swift` mounts a single TTSObserver at app launch, NOT on a
SwiftUI view's `.task`. Critical to fix the LSUIElement window-mount bug
(`nx-s7obw`): when no window is presented, view-attached `.task` modifiers
never fire. App-level observers are immune.

```swift
@main
struct NexusApp: App {
    @StateObject private var ttsObserver: TTSObserver

    init() {
        // 1. Request notification permission
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }

        // 2. Build observer with injected deps (KeychainStore, etc.)
        let observer = TTSObserver(...)
        _ttsObserver = StateObject(wrappedValue: observer)

        // 3. Start subscription
        Task { @MainActor in
            await observer.start()
        }
    }
    // ... existing body
}
```

## Permission UX

`UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])`:

| State | What happens |
| --- | --- |
| User has not been asked | macOS system prompt at first launch. Modal, blocks app briefly. |
| User granted | Banners + sound work. No re-prompt. |
| User denied | Banners suppressed by OS. Audio still plays (AVAudioPlayer doesn't need permission). User can re-enable via System Settings → Notifications → Nexus. |
| Permission revoked | Banners stop. Audio continues. Logged once per app launch. |

The Nexus.app bundle id is `dev.leonardoacosta.nexus.mac`. macOS uses this
to track permission state. If permission is denied, the observer logs once
and continues with audio-only delivery.

## Fallback Chain

```
NotificationFired received
        │
        ▼
   channel == "tts"? ──No──> exit (other observers handle)
        │ Yes
        ▼
   post banner ─────────────> always attempted (silent on denied permission)
        │
        ▼
   ElevenLabs synth ──fails──> AVSpeechSynthesizer.speak(body)
        │ ok
        ▼
   AudioPlayer.play(mp3Data)
```

Failure conditions that trigger AVSpeechSynthesizer fallback:
- ElevenLabs API key missing from Keychain
- ElevenLabs HTTP 401/403 (quota, invalid key)
- ElevenLabs HTTP 5xx
- Network failure (URLError.networkConnectionLost, .timedOut, etc.)
- Returned mp3 data is < 1KB (likely error response)

Each fallback is logged with `os_log` at `.info` level so Console.app shows
the path taken.

## Logging Surface

TTSObserver emits structured `os_log` calls at each stage. Console.app
filter `process:nexus` produces a chronological pipeline trace:

| Stage | Log line |
| --- | --- |
| Event received | `TTSObserver: received id={id} channel={channel}` |
| Filter applied | (debug-only) `TTSObserver: dropped non-tts event` |
| Banner queued | `TTSObserver: banner posted id={id}` |
| Synth start | `TTSObserver: synth start (elevenlabs)` |
| Synth result | `TTSObserver: elevenlabs returned {N} bytes` OR `TTSObserver: elevenlabs failed ({reason})` |
| Fallback | `TTSObserver: fallback to AVSpeechSynthesizer` |
| Playback | `TTSObserver: audioPlayer.play succeeded` |

This closes the diagnostic gap that surfaced in `nx-8e81d` (zero Console
output from the Swift app made the TTS path un-debuggable from outside).

## Testing Strategy

### Unit (NexusSharedTests)

`TTSObserverTests.swift`:
- `testStartRegistersHandler` — start() returns, observer is in "subscribed" state.
- `testStopCancelsSubscription` — stop() unregisters cleanly; subsequent SSE frames are ignored.
- `testNonTtsChannelIgnored` — receives a `notification` event with channel="desktop", asserts no audio + no banner attempted.
- `testElevenLabsFailureFallsBackToSystemSpeech` — inject failing ElevenLabsClient mock, assert SystemSpeechSynthesizer.speak called once.
- `testBannerPostedRegardlessOfSynth` — both synth paths post a banner via mock UNUserNotificationCenter.

### Integration (manual + runtime smoke)

`nexus-mac/Tests/TTSObserverIntegrationTest.swift`:
- Build a real TTSObserver with a stub-agent emitting one NotificationFired.
- Assert AudioPlayer received non-empty mp3Data (via test-only delegate hook).
- Time budget: 2s from emit to play.

### End-to-end (Leo to verify)

From Mac shell after deploy:

```bash
source ~/.env
source ~/.claude/scripts/lib/nx-send.sh
nx_notify "e2e smoke test from orchestrator"
```

Verify within 2s:
1. macOS banner appears with "Nexus" title and the body text.
2. Audio plays (ElevenLabs voice if Keychain key set, system voice otherwise).
3. Console.app filter `process:nexus` shows the pipeline trace.

Capture screenshot of Notifications HISTORY in dashboard for the audit trail.

## Risk Mitigation

| Risk | Mitigation |
| --- | --- |
| Permission prompt blocks app launch | Request is async with completion handler; doesn't block the runloop. If user dismisses without choosing, the prompt re-appears on next launch. |
| ElevenLabs synth latency stalls banner | Banner posts BEFORE synth attempt. User sees notification immediately even on slow network. |
| AVSpeechSynthesizer rate is too fast/slow | Default rate (AVSpeechUtteranceDefaultSpeechRate) is the Apple-standard reading pace. Configurable via Settings if needed (deferred). |
| Multiple events arrive faster than synth | AVSpeechSynthesizer queues utterances internally. AudioPlayer drops in-flight if a new event arrives (intentional — most recent wins). |
| Memory leak from retained AVAudioPlayer | AudioPlayer.shared sets `player = nil` in `audioPlayerDidFinishPlaying` delegate. Verified in v1 cut. |
