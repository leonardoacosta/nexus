<!-- beads:epic:nx-sk3dc -->
<!-- beads:feature:nx-9zcpq -->

# Tasks: mac-tts-integration-test

## DB Batch

## API Batch

## UI Batch

## E2E Batch

- [ ] [1.1] Build a stub-agent-driven integration harness: emit a `NotificationFired` SSE event and assert the Swift TTS observer consumes it and invokes the audio/synthesis path (mock the actual player); skip cleanly when audio hardware is unavailable [owner:e2e-engineer] [type:testing] [beads:nx-h3biv]
- [ ] [1.2] Run the harness and confirm it asserts the NotificationFired->playback round-trip deterministically [owner:e2e-engineer] [type:testing]
