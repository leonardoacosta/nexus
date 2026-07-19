---
order: 0719c
---

# Conditional Scroll for Non-Alt-Screen Sessions on iOS Attach

## Why

`TerminalHostView.swift` sets `view.isScrollEnabled = false` (SCROLL LOCK, bd:mx-rkir.11) because
these are tmux ALT-SCREEN sessions — scrolling SwiftTerm's local scrollback exposes stale buffer
rows tmux is actively redrawing over, producing colored noise/garble. A real, previously-fixed
bug, not speculative.

That lock is blanket: it disables scroll for EVERY session, including plain shells that are never
in alt-screen mode and have no garble risk at all. After tonight's keyboard-aware-resize work
(keyboard-aware-terminal-resize-ios) shipped and the keyboard-dismiss button was confirmed
working on-device, Leo asked for scroll back "when the keyboard is down" — the garble risk only
applies to alt-screen sessions (Claude Code's own TUI is the primary one), not to normal shell
output review.

SwiftTerm's `Terminal` class already exposes `public var isCurrentBufferAlternate: Bool { buffer
=== altBuffer }` (confirmed via source read,
`SourcePackages/checkouts/SwiftTerm/Sources/SwiftTerm/Terminal.swift:342`) — SwiftTerm parses the
ANSI escape sequences that toggle alt-screen mode (`\e[?1049h`/`\e[?1049l`) as part of normal
terminal emulation, so this state is already live and correct on the client. No new agent/backend
signal, session-model field, or wire-protocol change is needed — this is a self-contained iOS
change.

## What Changes

- Gate `view.isScrollEnabled` on two live conditions instead of a hardcoded `false`: keyboard is
  down (`keyboardOverlap == 0`, already threaded through from the keyboard-aware-resize work) AND
  the session is NOT currently in alt-screen mode (`view.getTerminal().isCurrentBufferAlternate
  == false`).
- Re-evaluate on both triggers: keyboard show/hide (already observed) and buffer-mode transitions
  (a plain shell entering `less`/`vim`, or vice versa) — via SwiftTerm's `rangeChanged(source:
  startY:endY:)` delegate callback (already part of `TerminalViewDelegate`), gated by setting
  `notifyUpdateChanges = true` on the terminal view.
- Every OTHER scroll-lock property (`bounces`, `alwaysBounceVertical`, `alwaysBounceHorizontal`,
  `showsVerticalScrollIndicator`, `showsHorizontalScrollIndicator`, `contentInsetAdjustmentBehavior`)
  toggles in lockstep with `isScrollEnabled` — an alt-screen session must not show scroll
  indicators or accept bounce even momentarily.
- When scroll re-locks (keyboard comes back up, or the session transitions INTO alt-screen while
  scrolled away from live content), the view must snap back to the live/bottom position — never
  leave the user stuck looking at a stale scroll position once locked.

## Context
- depends on: `keyboard-aware-terminal-resize-ios`
- touches: `apps/swift/nexus-ios/Sources/Attach/TerminalHostView.swift`, `apps/swift/nexus-ios/Sources/Attach/SshTerminalSession.swift`

Swift-only change (nexus-ios), same files as `keyboard-aware-terminal-resize-ios` (still parked
under `openspec/changes/`, task 2.1 on-device verification pending) — declared as a soft
dependency (not a hard conflict) since both are mid-flight in the same area tonight; `/apply`
should not run them in a way that clobbers either. Dispatch `swift-engineer` per-spec (nx has no
project.toml — t3 mega-batch UI agent cannot build Swift).

## Impact

- Affected specs: `nexus-ios-client` (ADDED requirement — conditional scroll re-enable)
- Affected code: `TerminalHostView.swift` (scroll-lock property gating, `notifyUpdateChanges`),
  `SshTerminalSession.swift` (`rangeChanged` delegate implementation, re-pin-to-live-on-relock
  logic)
- No wire/protocol changes; agent-side session model untouched.

## Done Means

- With the keyboard down and the pane in a plain (non-alt-screen) shell, the user can drag-scroll
  the terminal to review recent output.
- With the keyboard down and the pane in alt-screen mode (e.g. the Claude Code TUI), scroll stays
  locked — no garble risk reintroduced.
- Scroll availability updates correctly and promptly when the session transitions between
  alt-screen and normal-screen mode, or when the keyboard shows/hides, without requiring a
  reattach.
- No stale/garbled content is ever visible, in any keyboard/alt-screen state combination.
- Re-locking (keyboard up, or entering alt-screen) while scrolled away from live content snaps
  back to the live position — never leaves the view stuck stale.

## Testing

- Unit: not applicable — `TerminalHostView`/`SshTerminalSession` have no existing XCTest target
  on the Linux-side CI path; verification is typecheck + on-device (below), matching every other
  spec in this feature area tonight.
- Machine gate: `ssh mac` + `xcodebuild -scheme nexus-ios -destination 'generic/platform=iOS
  Simulator'` (task 1.4) passes with zero errors.
- On-device: manual verification checklist (User Gate task 2.1) — scroll works in a plain shell
  with keyboard down, scroll stays locked in an alt-screen TUI session, transitions (enter/exit
  alt-screen, keyboard show/hide) update scroll state promptly, re-lock snaps back to live
  content, no garble in any state.
