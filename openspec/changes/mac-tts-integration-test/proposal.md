# mac-tts-integration-test

## Why

The mac-tts delivery path (agent SSE `NotificationFired` event → Swift audio playback) has no integration test, so regressions in TTS delivery slip through silently. A controlled, deterministic harness lets us assert that an emitted `NotificationFired` event actually reaches the Swift audio layer and triggers playback synthesis, catching breaks in the round-trip before they ship.

## What Changes

Add an integration-test harness that uses the existing `stub-agent` to emit a controlled `NotificationFired` SSE event and asserts the TTS/audio observer consumes it and triggers playback synthesis. The actual player (`AudioPlayer` / `AVSpeechSynthesizer`) is mocked so the assertion is deterministic, and the harness skips cleanly on CI runners without audio hardware.

## Context

- touches: `apps/agent/src/testing/stub-agent.ts`, `apps/swift/NexusShared/Observers/TTSObserver.swift`

## Non-Goals

- No changes to production TTS or audio playback behavior — test-only harness plus any seams needed to mock the player.
- No coverage of upstream notification generation; the harness starts at the `NotificationFired` SSE event.
- No real audio rendering or device-output verification — playback synthesis is asserted via a mock.
