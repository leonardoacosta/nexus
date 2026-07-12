## Context
Three iOS session-screen defects (#4 sheet→push, #3 deep-link rewire, #5 keyboard) bundled because
they converge on `RootScene` / `NavigationState` / `AttachScene` and the PTY interact lifecycle.
Source: 2026-06-18 Serval QoL exploration + the NXPTY diagnosis (memory `project-serval-qol`).
The keyboard mechanism is confirmed in code as writer-contention (the agent lazy-attaches the PTY
before the WS upgrade, so `claimWriter`'s `!stream` race is the unlikely branch); the agent log has
captured only `claimed:true` lone-Mac opens so far. Leo's decisions: symmetric last-open-wins
reclaim, evicted device reuses its existing read-only badge.

## Goals / Non-Goals
- Goals:
  - The session screen is a pushed navigation destination with a real back button.
  - Both `nexus://` verbs + the notification tap push the same screen; cross-tab + cold-launch land.
  - iOS keystrokes reach the PTY even when macOS is attached (symmetric reclaim).
  - Dead `SessionDetailScene` + `SessionListScene` removed.
- Non-Goals:
  - A read-only metadata detail screen (deep-link lands on the live terminal, per prior decision).
  - New eviction UI beyond the existing read-only badge.
  - On-device runtime proof of the APNS push tap (blocked on `nx-gsgvk`).

## Decisions

- **Decision: single `sessionPath` ( `[String]` of session ids ) replaces `attachingSessionId` /
  `selectedSessionId` / `SessionIdBox`.** A plain string array is simpler than `NavigationPath` for
  a homogeneous id stack and makes cold-launch buffering trivial (append once mounted). Both
  `nexus://session` and `nexus://attach` collapse to `sessionPath.append(id)`.

- **Decision: `selectedTab` binding on the `TabView` is required, not optional.** Cross-tab Attach
  buttons (NotificationDetailScene) and the APNS observer must select the Sessions tab before the
  push resolves, since `.navigationDestination` only lives on the Sessions stack. Add
  `@Published var selectedTab` to `NavigationState`; deep-link / tap handlers set it then append.

- **Decision: `AttachScene` sheds its modal idioms.** Remove the inner `NavigationStack` wrapper
  (a pushed view inherits the parent stack's bar — nesting double-wraps) and the
  `Close`/`@Environment(.dismiss)` button (back comes from the stack). Keep the trailing status
  badge toolbar item and the `.id(resolved.id)` mount-once guard.

- **Decision: symmetric last-open-wins lives entirely in `claimWriter` ( `stream-manager.ts` ).**
  When `interactiveWriter` is a different live socket, close it `4009` and reassign to the new
  socket, returning `true` (instead of `return false`). Reusing the existing `4009` close means the
  macOS (`PtyInteractChannel.markReadOnly` on `.failed/.cancelled`) and web
  (`agent-ws-client.ts:392` keys off 4009) clients flip to their existing read-only state with ZERO
  new client handling. The new opener is never closed `4009`.
  - Alternatives considered: a new `writer_revoked` control frame. Rejected — the existing 4009
    close already drives both clients' read-only paths; a new frame would add handling on every
    client for no behavioral gain.
  - Alternatives considered: iOS-privileged (asymmetric) eviction. Rejected by Leo — symmetric
    means switching back to the Mac reclaims input there too, matching one-user-two-devices.

- **Decision: belt-and-suspenders on the client.** `AttachScene` calls `disconnect()` /
  `closeInteract()` on dismissal (`.onDisappear`, since a pushed view's teardown timing differs
  from a sheet's `dismantleUIView`), and `SshTerminalSession.connect()` opens the interact channel
  after the output stream is established so the writer claim never races an unregistered stream.
  With symmetric reclaim the iOS open already wins, so this is robustness, not the primary fix.

## Risks / Trade-offs
- **PTY lifecycle re-tuning:** the mount-once / disconnect logic was tuned for sheet teardown; a
  pushed view may keep the destination alive or re-create it on path mutation. Mitigation: keep
  `.id(resolved.id)`, add `.onDisappear` disconnect, re-verify the terminal mounts once and
  disconnects on back-pop (mx-rkir.8 regression class).
- **Keyboard geometry under a nav bar:** a pushed view sits under the nav bar (the sheet did not),
  changing settled bounds that drive tmux sizing. Mitigation: verify post-layout sizing + first
  responder after a push transition on-device (mx-rkir.6 garble class).
- **macOS becomes evictable:** a behavioral change — the Mac viewer can lose its writer mid-session
  to a phone attach. Intended (Leo's symmetric choice); surfaced via the existing read-only badge.
- **Cold-launch deep link:** a path append before the stack mounts could drop. Mitigation: buffer a
  pending id and replay on mount (covered by the cold-launch scenario).
- **Push-tap verification blocked:** the notification→pushed-view path can't be runtime-proven until
  `nx-gsgvk`; the URL-scheme path and an agent-side `claimWriter` eviction unit test are the
  available runtime evidence.

## Migration Plan
No data migration. Deleting `SessionDetailScene` + `SessionListScene` is a code removal — grep for
references first, remove them, regenerate the Xcode project (`cd apps/swift && xcodegen generate`).
Rollback = restore the sheet binding + the two scenes and revert `claimWriter`.

## Open Questions
- None blocking. (In-app eviction notice intentionally deferred to the existing read-only badge.)
