# swift-client-polish

## Why

Two Swift-client UX/robustness gaps degrade the dashboard experience. The PTY Viewer uses a free-text session-id field, which is error-prone, instead of a live-session picker sourced from the aggregate client. And TTSObserver does not check the system mute state on startup, so when the Mac is muted users get silent confusion with no explanation for why TTS is inaudible.

## What Changes

Replace the PTY Viewer free-text session-id input with a live-session picker populated from the aggregate session list; add a startup system-mute check to TTSObserver that logs a clear warning when the Mac is muted.

## Context
- depends on: `fix-mac-app-install-staleness`, `agent-swift-readmodel-fields`
- touches: `apps/swift/nexus-mac/Sources/Dashboard/PtyViewer.swift`, `apps/swift/NexusShared/Observers/TTSObserver.swift`

## Non-Goals

- No change to the SSH/tmux attach transport itself.
- No new TTS voice configuration or per-project voice routing.
- No change to the aggregate client networking or agent discovery.
