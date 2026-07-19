---
order: 0719d
---

# Swipe-to-Page on iOS Attach Terminal

## Why

The original ask from tonight's very first exploration was "allow page up/down style scroll on
drag." `conditional-scroll-non-altscreen-ios` (shipped tonight) addressed the local-scrollback
half of that via drag — but only for non-alt-screen sessions, since alt-screen sessions (Claude
Code's own TUI) must stay locked to avoid exposing stale buffer rows tmux is actively redrawing
over (bd:mx-rkir.11).

SwiftTerm's own `TerminalView` already exposes public `pageUp()`/`pageDown()` methods
(`SwiftTerm/Sources/SwiftTerm/Apple/AppleTerminalView.swift:1865-1880`) that are ALREADY
alt-screen-aware:

```swift
public func pageUp() {
    if terminal.isDisplayBufferAlternate {
        send(EscapeSequences.cmdPageUp)   // alt-screen: send the escape sequence to the remote app
    } else {
        scrollUp(lines: terminal.rows)     // normal buffer: scroll the local buffer directly
    }
}
```

SwiftTerm's own accessory bar "pgup"/"pgdn" buttons already call these exact methods
(`iOSKeyboardView.swift:51-52`). A swipe gesture calling the same two public methods gives the
touch-native equivalent of those existing keyboard buttons, working correctly for BOTH session
types with zero new escape-sequence logic and zero duplicate alt-screen detection.

## What Changes

- Add a swipe (or pan) gesture recognizer to `PhoneTerminalView` in
  `TerminalHostView.swift`'s `makeUIView`, alongside the existing `UITapGestureRecognizer`
  (tap-to-refocus, `handleFocusTap`).
- Swipe DOWN (finger moves down, content-follows-finger — standard iOS scroll physics) calls
  `view.pageUp()` (reveals older content). Swipe UP calls `view.pageDown()` (reveals
  newer/later content).
- No coordinator bridge needed — `pageUp()`/`pageDown()` are public on `TerminalView` itself
  (`PhoneTerminalView`'s superclass), so the gesture recognizer's action can call them directly
  on the view, unlike the keyboard-dismiss case which needed the `AttachTeardown` bridge to
  reach a `private` coordinator property.

## Context
- depends on: `conditional-scroll-non-altscreen-ios`
- touches: `apps/swift/nexus-ios/Sources/Attach/TerminalHostView.swift`

Swift-only change (nexus-ios), single file. Soft dependency on `conditional-scroll-non-altscreen-ios`
(still parked, same file, mid-flight tonight) — not a hard conflict, just sequencing awareness for
`/apply`. Dispatch `swift-engineer` per-spec (nx has no project.toml — t3 mega-batch UI agent
cannot build Swift).

## Impact

- Affected specs: `nexus-ios-client` (ADDED requirement — swipe-to-page)
- Affected code: `TerminalHostView.swift` only (new gesture recognizer + two one-line action
  handlers)
- No wire/protocol changes; reuses SwiftTerm's existing public API and existing escape-sequence
  encoding — no new bytes, no new backend surface.

## Done Means

- Swiping down on the terminal view reveals older content (calls `pageUp()`); swiping up reveals
  newer content (calls `pageDown()`) — works regardless of keyboard state.
- For alt-screen sessions (e.g. the Claude Code TUI), the swipe sends the standard PgUp/PgDn
  escape sequence to the remote app; no local scroll-lock is touched or bypassed.
- For non-alt-screen sessions, the swipe scrolls the local SwiftTerm buffer directly — additive
  to, not conflicting with, the drag-scroll `conditional-scroll-non-altscreen-ios` already
  provides.
- The existing tap-to-refocus gesture continues to work unaffected by the new swipe recognizer.

## Testing

- Unit: not applicable — `TerminalHostView` has no existing XCTest target on the Linux-side CI
  path; verification is typecheck + on-device (below), matching every other spec in this feature
  area tonight.
- Machine gate: `ssh mac` + `xcodebuild -scheme nexus-ios -destination 'generic/platform=iOS
  Simulator'` (task 1.3) passes with zero errors.
- On-device: manual verification checklist (User Gate task 2.1) — swipe direction feels correct,
  works on both a plain shell and an alt-screen session, existing tap-to-refocus still works,
  and (best-effort, not guaranteed) confirm whether Claude Code's own TUI actually responds to
  the injected PgUp/PgDn sequence — if it doesn't, the swipe is a harmless no-op for that specific
  app, not a regression.
