# Change: airpods-stt-command

## Why

After a Claude session speaks a TTS notification, the natural next action is often to reply — "yes, continue", "run the tests", "defer that". Today that means switching to the terminal and typing. This change lets the user dictate a spoken command via AirPods during (or just after) a TTS notification and have the transcript injected into the session that spoke. It reuses the Now-Playing window established by `airpods-tts-cancel`, so AirPods gestures become a voice-command surface for the last-active TTS session.

## What Changes

- Add an on-device speech recognizer (`SFSpeechRecognizer` + `AVAudioEngine`) wrapped in a `SpeechController` (NexusShared) with explicit start/stop.
- Add an AirPods STT trigger, gated to the Now-Playing window (TTS playback + 2s grace): **double-press** (`MPRemoteCommandCenter.nextTrackCommand`) → start recording; the next press → stop + send.
- Track the **last-notified TTS session** (project + session id) in `TTSObserver` so the transcript has a routing target.
- Route the final transcript to that session via the existing `POST /commands/send-text` (Swift `NexusClient.sendText`) → agent → tmux pane.
- Request the required TCC permissions: microphone and speech recognition.

> **Descoped (2026-05-24):** the Globe/dictation-key hold-to-talk trigger was dropped. The Globe/fn key is not cleanly interceptable via a session `CGEventTap` (consumed by WindowServer/HID below the tap layer; reserved for system dictation). STT ships AirPods-only — no `CGEventTap`, no Accessibility permission. A normal hold-hotkey could be added later if desired (tracked separately).

## Context

- depends on: `airpods-tts-cancel`
- touches: `apps/swift/NexusShared/Speech/SpeechController.swift`, `apps/swift/NexusShared/Observers/TTSObserver.swift`, `apps/swift/NexusShared/Observers/NowPlayingController.swift`, `apps/swift/NexusShared/Networking/NexusClient.swift`, `apps/swift/nexus/nexus/Info.plist`, `apps/swift/nexus-mac/Tests/SttCommandTests.swift`

## Impact

- **Capability:** mac-tts-listener
- **Breaking:** No — additive on top of `airpods-tts-cancel`. If the recognizer is unavailable or unauthorized, the feature degrades to no-op (TTS-cancel still works).
- **Permissions (NEW, 2 TCC prompts):** `NSMicrophoneUsageDescription` and `NSSpeechRecognitionUsageDescription`, requested lazily on first dictation attempt. (No Accessibility — the Globe-key path was dropped.)
- **Privacy:** recognition is on-device (`requiresOnDeviceRecognition = true`); no audio leaves the Mac.
- **Files changed:** ~4 Swift + Info.plist + 1 test. Mac-only.

## Design Notes

- **Gesture map (active only during the Now-Playing window from `airpods-tts-cancel`):**
  - single-press while TTS playing → cancel TTS (owned by `airpods-tts-cancel`)
  - double-press → start STT recording; next press → stop + send
- **Stop semantics:** recording stops on the next press after a double-press start (deterministic, no silence auto-stop in v1).
- **Routing target:** the project/session of the most recent `NotificationFired` observed when dictation started. If no session is resolvable, the transcript is surfaced in a banner instead of injected (fail-safe).
