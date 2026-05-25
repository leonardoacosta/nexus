<!-- beads:epic:nx-rxlbi -->
<!-- beads:feature:nx-5p5st -->

# Tasks: swift-client-polish

## UI Batch
- [x] [1.1] PTY Viewer: replace the free-text session-id field with a live-session picker populated from the aggregate session list [owner:ui-engineer] [type:ui] [beads:nx-zqntf]
- [x] [1.2] TTSObserver: on startup, query the system mute state and log a clear warning when the Mac is muted (so silent TTS is explained) [owner:ui-engineer] [type:ui] [beads:nx-8a4z3]

## E2E Batch
- [x] [2.1] Verify the picker lists live sessions and selecting one attaches; verify the mute-warning log fires when muted [owner:e2e-engineer] [type:testing]
