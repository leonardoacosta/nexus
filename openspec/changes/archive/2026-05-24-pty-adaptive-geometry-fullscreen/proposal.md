# Proposal: PTY adaptive geometry + true fullscreen

## Why

Two defects make the macOS dashboard's PTY viewer unusable for real session
inspection:

1. **Jumbled streaming.** The agent streams a tmux pane's raw bytes, which are
   already composed for the pane's fixed column/row geometry. SwiftTerm renders
   those bytes at whatever size the SwiftUI frame happens to be. Resize is a
   deliberate no-op on both ends — `apps/agent/src/terminal/tmux-pty-source.ts`
   ("Resize is a no-op — tmux owns the pane geometry") and
   `PtyTerminalCoordinator.sizeChanged(...) {}` in
   `apps/swift/nexus-mac/Sources/Dashboard/PtyViewer.swift`. When the render grid
   differs from the source grid, Claude Code's full-screen TUI cursor-positioning
   escapes (`CUP`) land in the wrong cells, producing the overlapping/garbled
   output captured in `docs/screenshots/img-20260524-164726.png`.

2. **No true fullscreen.** The dashboard `Window` intends to support native
   green-button fullscreen (`.fullScreenPrimary` is inserted via `WindowAccessor`
   at `AppNavigation.swift`, and activation policy is `.regular`). But
   `WindowAccessor` applies the collection behavior in a single one-shot
   `DispatchQueue.main.async` guarded by `if let window = view.window`, and
   `updateNSView` is empty. A SwiftUI `Window` scene lazy-mounts, so on that first
   runloop tick `view.window` is frequently `nil`, the closure no-ops, and
   `.fullScreenPrimary` is never set. The green button zooms/maximizes instead of
   entering a fullscreen Space ("its own virtual desktop").

The two bugs compound: even after fullscreen works, the jumble gets worse (larger
grid delta), so they ship as one change.

## What Changes

### Part A — Adaptive PTY geometry (fixes jumble)

- The agent reports the tmux pane's geometry (`pane_width` x `pane_height`) for an
  attached session so a viewer can size its emulator to match.
- **Lock mode (default):** the SwiftTerm grid is constrained to the reported pane
  geometry. ANSI output lines up exactly; no tmux state is mutated; fully
  read-only and reversible.
- **Take-over mode (opt-in, managed-gated):** the viewer forwards its own grid
  size to the agent, which resizes the tmux pane so the viewer can use the full
  window. Gated on `sessionType == "managed"` (reuses the existing input-forwarding
  gate in `PtyViewer`). On viewer detach/close, the agent **auto-restores** the
  pane to its pre-take-over geometry so a co-viewer is never left with a
  wrong-sized terminal. The mode is a header toggle with **no confirmation
  dialog** (managed-gated + auto-restore make it safe).

### Part B — Robust true fullscreen

- `WindowAccessor` applies `.fullScreenPrimary` idempotently and reliably:
  re-applying in `updateNSView` and retrying window resolution until `view.window`
  is non-nil, so the green button always enters a fullscreen Space.

## Impact

- Affected capabilities: `terminal-attach` (agent geometry report + take-over
  resize/restore), `swift-menubar-client` (SwiftTerm grid lock, take-over toggle,
  robust fullscreen window behavior).
- No DB schema changes. No breaking API changes — geometry reporting and the
  resize command are additive.

## Context

- depends on: none
- touches: `apps/agent/src/terminal/tmux-pty-source.ts`, `apps/agent/src/terminal/pty-source.ts`, `apps/agent/src/server-websocket.ts`, `apps/swift/NexusShared/Networking/NexusClient.swift`, `apps/swift/NexusShared/Networking/NexusAggregateClient.swift`, `apps/swift/nexus-mac/Sources/Dashboard/PtyViewer.swift`, `apps/swift/nexus/nexus/WindowAccessor.swift`, `apps/swift/nexus-mac/Sources/AppNavigation.swift`, `apps/swift/NexusSharedTests/PtyAttachTests.swift`

Note: `apps/swift/NexusShared/Networking/NexusClient.swift` is also in the
`- touches:` set of the in-flight `airpods-stt-command` proposal. This is a
wave-level file overlap (different sections of the file), not a logical
dependency; the `wave-plan-build` conflict matrix serializes the two specs into
different waves automatically.
