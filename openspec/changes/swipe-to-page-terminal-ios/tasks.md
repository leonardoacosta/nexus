---
stack: t3
---
<!-- beads:epic:nx-ywqig -->
<!-- beads:feature:nx-6nz86 -->

# Tasks: Swipe-to-Page on iOS Attach Terminal

## UI Batch

- [x] 1.1 In `apps/swift/nexus-ios/Sources/Attach/TerminalHostView.swift`'s `makeUIView`, add a `UISwipeGestureRecognizer` for `.down` calling `view.pageUp()` and a second for `.up` calling `view.pageDown()` (or a single `UIPanGestureRecognizer` distinguishing direction on `.ended`, engineer's choice — either approach must not require touching `SshTerminalSession.swift`, since `pageUp()`/`pageDown()` are public on `TerminalView`/`PhoneTerminalView` directly). Add alongside the existing `UITapGestureRecognizer` (~line 128-133) — do not remove or modify it. Direction convention: swipe DOWN = `pageUp()` (reveal older content, content-follows-finger), swipe UP = `pageDown()` (reveal newer content). [beads:nx-89qk3]
- [x] 1.2 Verify (via LSP/read, not by running the app) that the new gesture recognizer(s) do not require `UIGestureRecognizerDelegate` simultaneous-recognition tuning to coexist with the existing tap recognizer — `UISwipeGestureRecognizer`/`UIPanGestureRecognizer` and `UITapGestureRecognizer` recognize different gesture shapes and coexist by default in UIKit without delegate work in the common case; if the actual behavior needs delegate tuning once built, add it, but don't add speculative delegate code if it's not needed. [beads:nx-685zl]
- [x] 1.3 Typecheck/build gate: from Linux, run the headless Mac build (`ssh mac` + `xcodegen generate` + `xcodebuild -scheme nexus-ios -destination 'generic/platform=iOS Simulator' build`) and paste passing output; zero errors. [beads:nx-r0vyy]

## User Gate

- [ ] 2.1 [user:post] On-device verification on the iPhone (GUI-bound): attach a plain shell session, swipe down/up, confirm older/newer content reveals correctly and the direction feels natural; attach/observe an alt-screen session (e.g. the Claude Code TUI), swipe down/up, confirm the PgUp/PgDn escape sequence is sent (note whether the TUI itself visibly responds — if not, that's a property of the remote app, not a regression here); confirm the existing tap-to-refocus gesture still works after the new recognizer is added. searched: nx open beads + archived Attach/terminal specs for an existing swipe-gesture verification checklist; only the keyboard-resize/dismiss/conditional-scroll checklists exist, none covers swipe-to-page — new manual step required. [beads:nx-1ohwf]
