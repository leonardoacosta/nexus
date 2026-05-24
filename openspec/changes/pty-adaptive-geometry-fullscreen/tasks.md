<!-- beads:epic:nx-jnqzb -->
<!-- beads:feature:nx-3bai2 -->
# Tasks: PTY adaptive geometry + true fullscreen

## API Batch

Agent-side (Bun/TypeScript). Geometry reporting, viewer-driven resize, auto-restore.

- [x] 1.1 Add a `geometry()` accessor to the `PtySource` interface in `apps/agent/src/terminal/pty-source.ts` returning current `{ cols, rows }`; implement for `NodePtySource` (return configured dims). [beads:nx-mfg7y]
- [x] 1.2 Implement geometry acquisition in `apps/agent/src/terminal/tmux-pty-source.ts` via `tmux display-message -p -t <target> '#{pane_width}x#{pane_height}'`; cache last value and detect changes on the pipe-pane read loop. [beads:nx-is4gm]
- [x] 1.3 Implement `resize(cols, rows)` in `TmuxPtySource` via `tmux resize-window -t <target> -x <cols> -y <rows>`, setting `window-size manual` for the take-over duration and recording the prior `window-size` option (replaces the current no-op). [beads:nx-m79mr]
- [x] 1.4 In `apps/agent/src/server-websocket.ts`, emit a `{"type":"geometry","cols":..,"rows":..}` TEXT control frame to a viewer at attach (before/with initial scrollback) and whenever source geometry changes. [beads:nx-hg9n6]
- [x] 1.5 Add `POST /commands/resize` route (mirror `commands-send-text`): validate positive in-range `cols`/`rows`, enforce `sessionType == "managed"` server-side (reject non-managed with non-2xx), record original pane geometry on first resize, then apply via `PtySource.resize`. [beads:nx-j4acp]
- [x] 1.6 Wire auto-restore into the `removeViewer`/`endSession` teardown path: when the last take-over viewer disconnects (normal close OR pong timeout), restore the recorded original geometry + prior `window-size` option, then clear the record. [beads:nx-8qd4q]

## UI Batch

Swift-side (NexusShared + nexus-mac). Geometry consumption, grid lock, take-over toggle, robust fullscreen.

- [x] 2.1 In `apps/swift/NexusShared/Networking/NexusClient.swift` PTY WebSocket bridge, branch on WS message type: parse TEXT frames as JSON control messages and surface a `geometry(cols, rows)` event to the `consumePtyStream` handler; keep binary frames as raw bytes. [beads:nx-mmbvx]
- [x] 2.2 Add `requestResize(sessionId, cols, rows, originAgent)` to `NexusClient` + `NexusAggregateClient` (`apps/swift/NexusShared/Networking/NexusAggregateClient.swift`) calling `POST /commands/resize`. [beads:nx-wlm8g]
- [x] 2.3 In `apps/swift/nexus-mac/Sources/Dashboard/PtyViewer.swift`, add `geometryMode` (`.lock` default / `.takeOver`) and `reportedGeometry` to `PtyViewerModel`; on a `geometry` event in lock mode, resize the SwiftTerm grid to the reported `cols` x `rows`. [beads:nx-8aqzl]
- [x] 2.4 Constrain/letterbox `PtyTerminalRepresentable` so a frame larger than the reported geometry leaves empty space instead of stretching the grid (lock mode). [beads:nx-9w734]
- [x] 2.5 Implement `PtyTerminalCoordinator.sizeChanged(newCols, newRows)` (currently a no-op) to forward to `model.requestResize` ONLY when `geometryMode == .takeOver`. [beads:nx-zo6jz]
- [x] 2.6 Add a managed-gated take-over toggle to the `PtyViewer` header (hidden/disabled when `sessionType != "managed"`, no confirmation dialog); enabling forwards current grid size, disabling/`onDisappear` reverts to lock mode. [beads:nx-0ky0s]
- [x] 2.7 Make `apps/swift/nexus/nexus/WindowAccessor.swift` apply `onWindow` reliably: retry window resolution on subsequent runloop ticks until `view.window` is non-nil, and re-apply from `updateNSView` (insert is idempotent) so `.fullScreenPrimary` is always set on the dashboard `Window`. [beads:nx-ggepd]

## E2E Batch

Tests proving the spec assertions hold at runtime.

- [x] 3.1 Agent test: a tmux-backed stream emits a `geometry` control frame at attach with the pane's `cols`/`rows`. [beads:nx-tubsz]
- [x] 3.2 Agent test: `POST /commands/resize` on a managed session resizes the pane and records original geometry; a non-managed session is rejected; invalid dims are rejected. [beads:nx-ypn1e]
- [x] 3.3 Agent test: last take-over viewer disconnect restores original pane geometry; a never-resized viewer's disconnect does not resize. [beads:nx-mf7w1]
- [x] 3.4 Swift test in `apps/swift/NexusSharedTests/PtyAttachTests.swift`: a `geometry` control frame in lock mode sets the SwiftTerm grid to the reported size; `sizeChanged` forwards a resize only in take-over mode. [beads:nx-jsisz]
- [ ] 3.5 Manual/UI verification: green-button fullscreen enters a fullscreen Space, and PTY output renders aligned (no jumble) in lock mode against a live homelab session — capture a screenshot to `docs/screenshots/`. [beads:nx-evx6k]
