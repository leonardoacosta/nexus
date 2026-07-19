---
stack: t3
---
<!-- beads:epic:nx-ywqig -->
<!-- beads:feature:nx-ydpur -->

# Tasks: Keyboard-Aware Terminal Resize on iOS Attach

## UI Batch

- [x] 1.1 In `apps/swift/nexus-ios/Sources/Attach/TerminalHostView.swift`'s `makeUIView`, register `UIResponder.keyboardWillShowNotification` / `keyboardWillHideNotification` observers (via `NotificationCenter` on the coordinator, torn down in `dismantleUIView` alongside the existing `coordinator.disconnect()` call). On show, read `UIResponder.keyboardFrameEndUserInfoKey` and convert to the view's local coordinate space to get the overlap height; on hide, treat overlap as 0. [beads:nx-eqpvh]
- [x] 1.2 In `AttachScene.swift`, replace the blanket `.ignoresSafeArea(edges: .bottom)` on `TerminalHostView` with keyboard-aware frame accounting: the terminal view's height SHALL shrink by the keyboard overlap height from 1.1 (published via a `@Binding`/`@State` the coordinator updates), so `PhoneTerminalView.layoutSubviews()` (bd:mx-rkir.6, already fires "on first layout, rotation, AND keyboard frame change" per its own doc comment) picks up the new bounds through the same path rotation already exercises. Do NOT touch `view.isScrollEnabled` / `view.bounces` / the other SCROLL LOCK properties (bd:mx-rkir.11, lines ~141-147) — those stay exactly as they are. [beads:nx-wwoot]
- [x] 1.3 In `SshTerminalSession.swift`, debounce the keyboard-triggered resize path: coalesce rapid consecutive keyboard show/hide-driven `sizeChanged` calls (e.g. a ~150-250ms trailing debounce) before calling `pushResize(cols:rows:reason:)`, so fast keyboard dismiss/re-show cycles issue one resize call, not one per notification. Reuse the existing `pushResize` function and its `POST /commands/resize` call — do not add a new backend call shape. [beads:nx-gmes8]
- [x] 1.4 Typecheck gate: from Linux, run the headless Mac typecheck (`ssh mac` + `swiftc -typecheck` over nexus-ios sources per the swift-engineer contract, or the fuller `xcodebuild -scheme nexus-ios -destination 'generic/platform=iOS Simulator'` build gate already used for `nx-ywqig.1`) and paste passing output; zero errors. [beads:nx-zjlci]

## User Gate

- [x] 2.1 [user:post] On-device verification on the iPhone (GUI-bound): attach a live session, tap to bring up the keyboard, confirm the current cursor/prompt line is visible above the keyboard (not hidden behind it); dismiss the keyboard, confirm the view resizes back to full height smoothly; rapidly toggle the keyboard several times, confirm no visible garble/flash and no excessive lag (debounce working); confirm dragging on the terminal still does NOT scroll (scroll lock intact). searched: nx open beads + archived Attach/terminal specs for an existing keyboard-resize verification checklist; only the render-fix checklist (nx-ywqig.1) and general on-device checklists exist, none covers keyboard-driven resize — new manual step required. [beads:nx-xk6ww]
