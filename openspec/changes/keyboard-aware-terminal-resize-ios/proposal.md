---
order: 0719b
---

# Keyboard-Aware Terminal Resize on iOS Attach

## Why

On the iOS Attach screen, `AttachScene` renders `TerminalHostView` with
`.ignoresSafeArea(edges: .bottom)` and no keyboard-avoidance. When the system keyboard appears,
the terminal view keeps its full-bleed frame — the keyboard (plus SwiftTerm's own accessory row)
overlays the bottom rows of the live pane, including the current cursor/prompt line. The user can
no longer see what they're typing, and cannot recover by scrolling: `view.isScrollEnabled = false`
is a deliberate, previously-hardened decision (bd:mx-rkir.11) — these are tmux ALT-SCREEN sessions,
and scrolling into SwiftTerm's local scrollback exposes stale buffer rows tmux is actively
redrawing over, producing colored noise/garble. Re-enabling scroll is out of scope and would
regress a fixed bug.

`PhoneTerminalView.layoutSubviews()` already documents itself as firing "on first layout,
rotation, AND keyboard frame change" (bd:mx-rkir.6) — the resize-driven tmux-regrid plumbing
(`onSettledLayout` -> `coordinator.handleSettledLayout` -> `sizeChanged` -> `pushResize`) already
exists and is exercised today by device rotation. Nothing currently triggers an actual frame
change in response to a keyboard show/hide notification — the plumbing is half-built.

## What Changes

- Observe `UIResponder.keyboardWillShowNotification` / `keyboardWillHideNotification` (or
  SwiftUI's keyboard-height equivalent) in the Attach terminal host and translate the keyboard
  height into a frame/height change on `PhoneTerminalView`, so its existing `layoutSubviews` path
  picks it up exactly as it already does for rotation.
- The resulting resize reflows tmux's real grid via the existing take-over resize path
  (`sizeChanged` -> `pushResize` -> `POST /commands/resize`, spec `pty-adaptive-geometry-fullscreen`)
  — the same mechanism rotation already drives. This is a deliberate reuse, not new backend
  surface: the agent's take-over model already treats "the currently-attached client's geometry
  need temporarily wins" as accepted behavior for rotation; this proposal applies the same
  mechanism to a new, more frequent trigger.
- Debounce rapid keyboard show/hide toggles before calling resize, so fast keyboard
  dismiss/re-show cycles (e.g. switching between typing and glancing at output) don't spam
  `POST /commands/resize` calls.
- On keyboard hide, resize back to the full available height (reusing the same path).

## Context
- touches: `apps/swift/nexus-ios/Sources/Attach/TerminalHostView.swift`, `apps/swift/nexus-ios/Sources/Attach/AttachScene.swift`, `apps/swift/nexus-ios/Sources/Attach/SshTerminalSession.swift`

Swift-only change (nexus-ios). No new API/DB surface — reuses the existing
`POST /commands/resize` take-over endpoint (`pty-adaptive-geometry-fullscreen`, already shipped).
Dispatch `swift-engineer` per-spec (nx has no project.toml — t3 mega-batch UI agent cannot build
Swift).

## Impact

- Affected specs: `nexus-ios-client` (ADDED requirement — keyboard-aware terminal resize)
- Affected code: `TerminalHostView.swift` (keyboard notification observation, frame/height
  change wiring), `AttachScene.swift` (keyboard-avoidance frame accounting instead of blanket
  `.ignoresSafeArea(edges: .bottom)`), `SshTerminalSession.swift` (debounced resize trigger from
  the keyboard-frame handler, reusing the existing `pushResize` path — no new backend call shape)
- No wire/protocol changes; the agent-side `/commands/resize` route and take-over registry are
  reused as-is.

## Done Means

- With the iOS keyboard up during a live Attach session, the terminal's current cursor/prompt
  line remains visible above the keyboard (not hidden behind it).
- The existing scroll lock (mx-rkir.11) is preserved — no user-drag-scroll into local scrollback
  is introduced or re-enabled.
- Keyboard show/hide transitions resize the terminal view smoothly (reusing the existing
  rotation-resize path) without a visible garble/flash.
- Rapid keyboard show/hide toggling does not spam resize calls (debounced).

## Testing

- Unit: not applicable — `TerminalHostView`/`AttachScene` have no existing XCTest target on the
  Linux-side CI path; verification is typecheck + on-device (below), matching the pattern already
  established for `optimize-board-render-hot-paths` and `nx-ywqig.1` in this same fleet.
- Machine gate: `ssh mac` + `xcodebuild -scheme nexus-ios -destination 'generic/platform=iOS
  Simulator'` (task 1.4) passes with zero errors.
- On-device: manual verification checklist (User Gate task 2.1) — cursor visibility with keyboard
  up, scroll-lock still intact, smooth resize transition, rapid-toggle debounce.
