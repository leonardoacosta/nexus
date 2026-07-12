# Change: iOS session navigation — pushed session view, deep-link rewire, writer reclaim

## Why
Three entangled iOS session-screen defects from the 2026-06-18 Serval QoL exploration. They all
converge on the same hot files (`RootScene`, `NavigationState`, `AttachScene`) and the PTY
interact lifecycle, so they ship together — splitting them would triple-verify the same diffs.

1. **The session screen is a modal sheet, not a pushed view.** `AttachScene` (the live PTY
   terminal) is presented by a single root `.sheet(item:)` bound to
   `NavigationState.attachingSessionId`. It opens as a modal card instead of a navigation
   destination, and the second deep-link verb (`nexus://session/<id>`) is stranded because the
   sheet only ever consumes `attachingSessionId`.
2. **The notification deep-link rides the sheet.** Tapping a push posts `.nexusOpenSessionDetail`
   → sets `attachingSessionId` → the sheet. Once the screen becomes a pushed destination, the
   APNS observer and both `nexus://` verbs must append to the navigation path instead.
3. **The keyboard silently drops keys.** Keystrokes fire (`NXPTY send bytes=1`) but the interact
   WebSocket latches read-only after the agent closes it `4009` — the macOS PtyViewer holds the
   single-writer mutex and iOS, opening second, is denied. Confirmed in code (the agent
   lazy-attaches the PTY before upgrade, so the live mechanism is writer-contention, not the
   open-before-PTY race); the agent log has recorded only `claimed:true` (lone-Mac) opens so far.

## What Changes
- **Session screen becomes a pushed `.navigationDestination`.** `NavigationState` gains a
  `sessionPath` and a `selectedTab`; both `nexus://session/<id>` and `nexus://attach/<id>`
  collapse to append the session id to that path; the root `.sheet(item:)` is deleted. `AttachScene`
  loses its inner `NavigationStack` wrapper and its `Close`/`@Environment(.dismiss)` modal
  idioms (back-nav comes from the stack). A `TabView` `selection` binding lets cross-tab Attach
  buttons and the APNS tap switch to the Sessions tab before pushing.
- **BREAKING — dead-scene removal (approved):** `SessionDetailScene` and `SessionListScene` are
  deleted (neither is mounted in the active tab tree; `nexus://session` was a dead link). Their
  references are removed and the Xcode project regenerated.
- **Deep-link rewire:** the `.nexusOpenSessionDetail` observer appends to `sessionPath` + selects
  the Sessions tab. Runtime verification of a real push tap remains blocked on APNS provisioning
  (`nx-gsgvk`); the URL-scheme path is testable now.
- **Symmetric last-open-wins writer reclaim:** `claimWriter` evicts the current interact-writer
  instead of refusing the new opener — it closes the prior holder with `4009` (which the macOS
  and web clients already handle by flipping to their existing read-only badge) and assigns the
  writer to the new socket. **BREAKING (behavioral):** the macOS PtyViewer becomes evictable — a
  later iOS (or Mac) attach to the same session reclaims input; the bumped device goes read-only
  with no new UI. `AttachScene` also guarantees `disconnect()` on dismissal so a stale socket
  never holds the writer against the next attach.

## Impact
- Affected specs: `nexus-ios-client` (navigation refactor + deep-link rewire),
  `terminal-attach` (writer-reclaim protocol).
- Affected code:
  - `apps/swift/nexus-ios/Sources/App/NavigationState.swift` — `sessionPath`, `selectedTab`, verb collapse
  - `apps/swift/nexus-ios/Sources/Scenes/RootScene.swift` — path-bound stack + `.navigationDestination`, delete sheet, TabView selection
  - `apps/swift/nexus-ios/Sources/Attach/AttachScene.swift` — remove inner stack + Close; disconnect on dismiss
  - `apps/swift/nexus-ios/Sources/App/NexusAppDelegate.swift` — APNS observer target
  - `apps/swift/nexus-ios/Sources/Scenes/SessionsArchetypeScene.swift` — trigger appends to path
  - `apps/swift/nexus-ios/Sources/Scenes/NotificationDetailScene.swift` — Attach button appends to path + selects tab
  - `apps/swift/nexus-ios/Sources/Scenes/{SessionDetailScene,SessionListScene}.swift` — **deleted**
  - `apps/agent/src/terminal/stream-manager.ts` — `claimWriter` symmetric eviction
  - `apps/agent/src/server-websocket.ts` — interact-open path (no 4009 for the new winner)
  - `apps/swift/NexusShared/Networking/NexusClient.swift` + `apps/swift/nexus-ios/Sources/Attach/SshTerminalSession.swift` — evicted read-only handling, open-after-stream
  - `apps/web/src/lib/agent-ws-client.ts` — confirm evicted client flips read-only on 4009

## Context
- depends on: none
- touches: `apps/swift/nexus-ios/Sources/Scenes/RootScene.swift`, `apps/swift/nexus-ios/Sources/App/NavigationState.swift`, `apps/swift/nexus-ios/Sources/App/NexusAppDelegate.swift`, `apps/swift/nexus-ios/Sources/Attach/AttachScene.swift`, `apps/swift/nexus-ios/Sources/Attach/SshTerminalSession.swift`, `apps/swift/nexus-ios/Sources/Scenes/SessionsArchetypeScene.swift`, `apps/swift/nexus-ios/Sources/Scenes/NotificationDetailScene.swift`, `apps/swift/nexus-ios/Sources/Scenes/SessionDetailScene.swift`, `apps/swift/nexus-ios/Sources/Scenes/SessionListScene.swift`, `apps/swift/NexusShared/Networking/NexusClient.swift`, `apps/agent/src/terminal/stream-manager.ts`, `apps/agent/src/server-websocket.ts`, `apps/web/src/lib/agent-ws-client.ts`

> Note: `NotificationDetailScene.swift` is also touched by the in-flight `notification-fidelity`
> proposal (its title row). No logical dependency — the wave conflict matrix serializes the two
> into different waves via this shared `touches:` path.
