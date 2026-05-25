<!-- beads:epic:nx-jnqzb -->
<!-- beads:feature:nx-bv9oz -->

# Tasks

## DB Batch

(none — Swift client feature, no schema)

## API Batch

(none — agent `/sessions/:id/interact` WS + writer mutex already exist; no agent changes)

## UI Batch

- [x] Add an interact-channel API to `apps/swift/NexusShared/Networking/NexusClient.swift`: open an `NWConnection` to `WS /sessions/:id/interact` (reuse the `consumePtyStream` scheme-rewrite + `NWProtocolWebSocket` + finite-timeout-session pattern), expose `sendInteractiveInput(_ bytes: Data)` that writes raw bytes via `connection.send` (binary), and a lifecycle to open/close the channel. Handle WS close 4009 (writer-mutex denied) as a non-fatal read-only fallback (log, no crash).
- [x] Add the interact channel to `apps/swift/NexusShared/Networking/NexusAggregateClient.swift` (target the owning agent, mirroring how `consumePtyStream`/`sendText` resolve the agent).
- [x] Rewire `PtyViewer.forwardInput` (`apps/swift/nexus-mac/Sources/Dashboard/PtyViewer.swift`) to write keystroke bytes over the interact channel instead of `client.sendText`. Keep the `sessionType == "managed"` gate + one-shot non-managed warn. Open the interact channel when a managed PTY viewer attaches (`PtyViewerModel.start`) and close it on `stop()`/`onDisappear`.
- [x] Keep `NexusClient.sendText` intact and still used for programmatic command-line injection (STT transcript). Do NOT remove it.

## E2E Batch

- [x] Add tests in `apps/swift/NexusSharedTests/PtyAttachTests.swift` (inject a fake interact transport): a forwarded keystroke writes raw bytes with NO appended Enter and does NOT call `sendText`; a Return keypress sends a carriage return; a non-managed session opens no interact channel; a 4009 writer-denied close degrades to read-only without crashing.
- [ ] Manual verification (operator): attach a managed PTY (otaku-odyssey), type into Claude Code's prompt — confirm characters appear WITHOUT auto-submitting, Return submits, and the statusline no longer redraw-jumbles. Build + relaunch via `deploy/install.sh`. Capture a screenshot to `docs/screenshots/`.
