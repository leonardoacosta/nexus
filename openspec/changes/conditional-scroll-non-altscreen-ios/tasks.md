---
stack: t3
---
<!-- beads:epic:nx-ywqig -->
<!-- beads:feature:nx-dcqei -->

# Tasks: Conditional Scroll for Non-Alt-Screen Sessions on iOS Attach

## UI Batch

- [x] 1.1 In `apps/swift/nexus-ios/Sources/Attach/TerminalHostView.swift`'s `makeUIView`, set `view.notifyUpdateChanges = true` so SwiftTerm's `rangeChanged(source:startY:endY:)` delegate callback fires on buffer visual changes (needed to detect alt-screen transitions reactively, since SwiftTerm's `TerminalViewDelegate` has no dedicated buffer-swap hook — confirmed via source read of `TerminalViewDelegate.swift`). [beads:nx-3h4bk]
- [x] 1.2 In `SshTerminalSession.swift`, implement `rangeChanged(source:startY:endY:)` (currently absent from the delegate conformance — check current conformance list) to re-evaluate scroll-lock state: read `source.getTerminal().isCurrentBufferAlternate`, combine with the existing `keyboardOverlap`-derived down/up state (reuse the existing keyboard show/hide handlers — do not add a second keyboard-tracking mechanism), and apply the resulting `isScrollEnabled`/`bounces`/`alwaysBounceVertical`/`alwaysBounceHorizontal`/`showsVerticalScrollIndicator`/`showsHorizontalScrollIndicator` toggle in lockstep (all properties flip together, never independently). Extract a small helper (e.g. `applyScrollLockState(keyboardDown:alternateActive:)`) called from both the keyboard handlers and this new delegate callback, rather than duplicating the toggle logic in two places. [beads:nx-eyhwx]
- [x] 1.3 Also call the scroll-lock re-evaluation helper from the existing `keyboardWillShow`/`keyboardWillHide` handlers (SshTerminalSession.swift, ~line 366/383) so keyboard transitions re-check alt-screen state too, not just buffer transitions re-checking keyboard state — both triggers must converge on the same combined condition. [beads:nx-3lz7b]
- [x] 1.4 When scroll transitions from enabled -> disabled (keyboard shows, or alt-screen entered) while the view is scrolled away from the live/bottom position, snap `contentOffset` back to the live region (reuse whatever mechanism already pins live content — see the existing "SwiftTerm still updates contentOffset PROGRAMMATICALLY on each feed" behavior referenced in the SCROLL LOCK comment block, ~TerminalHostView.swift line 131-140) so the user is never left looking at a stale scrolled-away position once re-locked. [beads:nx-22eqr]
- [x] 1.5 Typecheck gate: from Linux, run the headless Mac typecheck (`ssh mac` + `swiftc -typecheck` over nexus-ios sources per the swift-engineer contract) or the fuller `xcodebuild -scheme nexus-ios -destination 'generic/platform=iOS Simulator'` build gate (same pattern used throughout tonight's session) and paste passing output; zero errors. [beads:nx-3sw31]

## User Gate

- [ ] 2.1 [user:post] On-device verification on the iPhone (GUI-bound): attach a plain shell session, confirm scroll works with keyboard down; attach/observe a Claude Code TUI (alt-screen) session, confirm scroll stays locked with keyboard down; toggle keyboard show/hide on both session types, confirm scroll state updates correctly; if possible, run `less`/`vim` inside a plain shell to trigger a live alt-screen transition and confirm scroll locks mid-session without reattaching; confirm no garbled/stale content appears in any state; confirm scrolling away then re-locking (keyboard up, or entering alt-screen) snaps back to live content. searched: nx open beads + archived Attach/terminal specs for an existing conditional-scroll verification checklist; only the keyboard-resize and dismiss-button checklists exist (keyboard-aware-terminal-resize-ios), none covers alt-screen-conditional scroll — new manual step required. [beads:nx-ntfa8]
