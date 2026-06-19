<!-- beads:epic:nx-ywqig -->
<!-- beads:feature:nx-6w2s0 -->

# Tasks: ios-session-navigation

> Internal sequencing: land the push refactor (#4, UI 2.1-2.4) first, then the deep-link rewire
> (#3, UI 2.5-2.6), then the writer reclaim (#5, API + UI 2.8). The agent-side reclaim (API) is
> file-independent of the Swift navigation and can proceed in parallel, but #5's on-device
> verification depends on the final pushed-view lifecycle.

## DB Batch

_No database changes._

## API Batch

- [x] 1.1 `claimWriter` symmetric last-open-wins in `apps/agent/src/terminal/stream-manager.ts:255-267`: when `interactiveWriter` is a different live socket, close it `4009` ("interactive writer reclaimed") and reassign to the new socket, returning `true` instead of `return false`. Keep the `!stream` branch returning false (unregistered stream). [owner:api-engineer] [beads:nx-21zcj]
- [x] 1.2 `apps/agent/src/server-websocket.ts:320-335`: confirm the interact-open handler no longer closes the NEW opener `4009` now that `claimWriter` returns true on contention; only the evicted prior holder is closed. Adjust the log/close branch as needed. [owner:api-engineer] [beads:nx-7w8xl]
- [x] 1.3 `apps/web/src/lib/agent-ws-client.ts:392`: confirm an evicted web client flips to read-only on the `4009` close (existing handling); add/adjust only if the eviction path differs from the prior denial path. [owner:api-engineer] [beads:nx-qohvt]
- [x] 1.4 Bun unit test for `claimWriter`: a second socket opening on a held session evicts the prior holder (prior gets `4009`), the new socket wins the writer, and a `!stream` open still returns false. This is the runtime evidence for the reclaim rule. [owner:test-writer] [beads:nx-vyew2]

## UI Batch

- [ ] 2.1 `NavigationState.swift:14-32`: add `@Published var sessionPath: [String]` and `@Published var selectedTab`; collapse `handle(deepLink:)` so both `nexus://session/<id>` and `nexus://attach/<id>` append `<id>` to `sessionPath`. Remove `attachingSessionId`, `selectedSessionId`, and the `SessionIdBox` wrapper. [owner:swift-engineer] [beads:nx-e7trw]
- [ ] 2.2 `RootScene.swift:71-124`: bind the Sessions-tab `NavigationStack(path: $navigation.sessionPath)` with `.navigationDestination(for: String.self) { AttachScene(sessionId: $0) }`; DELETE the root `.sheet(item:)`; add a `selection: $navigation.selectedTab` binding to the `TabView`. [owner:swift-engineer] [beads:nx-30186]
- [ ] 2.3 `AttachScene.swift:40,52,91-93,98`: remove the inner `NavigationStack { }` wrapper and the `Close` toolbar button + `@Environment(.dismiss)`. Keep the trailing status-badge toolbar item, `.navigationTitle`/`.inline`, and the `.id(resolved.id)` mount-once guard. [owner:swift-engineer] [beads:nx-ueznt]
- [ ] 2.4 `SessionsArchetypeScene.swift:116` (handleTap): replace `navigation.attachingSessionId = id` with `navigation.sessionPath.append(id)` (already on the Sessions tab — no tab switch needed). [owner:swift-engineer] [beads:nx-tzfmu]
- [ ] 2.5 `NotificationDetailScene.swift:74` (Attach button): set `navigation.selectedTab` to the Sessions tab, then `navigation.sessionPath.append(id)` (cross-tab push). [owner:swift-engineer] [beads:nx-557co]
- [ ] 2.6 APNS deep-link rewire (#3): the `.nexusOpenSessionDetail` observer (`RootScene.swift:103-109`, id from `NexusAppDelegate.swift:165-185`) selects the Sessions tab and appends to `sessionPath`. Buffer a pending id if the Sessions stack has not yet mounted (cold-launch) and replay on appear. [owner:swift-engineer] [beads:nx-1asjs]
- [ ] 2.7 Delete `SessionDetailScene.swift` + `SessionListScene.swift`; grep the iOS target for references and remove them; run `cd apps/swift && xcodegen generate`. Confirm no dangling references remain. [owner:swift-engineer] [beads:nx-gu0is]
- [ ] 2.8 Writer release (#5 client): `AttachScene` calls `disconnect()`/`closeInteract()` on `.onDisappear` (pushed-view teardown differs from sheet `dismantleUIView`); `SshTerminalSession.connect()` (`:116-128`) opens the interact channel AFTER the output stream is established so the writer claim never races an unregistered stream. [owner:swift-engineer] [beads:nx-0r1x5]

## E2E Batch

- [ ] 3.1 Build gate: `xcodebuild -scheme nexus-ios` compiles after the refactor + scene deletions, and `bun run --filter @nexus/agent build` (+ web typecheck) passes for the `claimWriter` change. Paste the success output. [owner:e2e-engineer] [beads:nx-1h1h0]
- [ ] 3.2 Manual: opening `nexus://session/<id>` and `nexus://attach/<id>` pushes the live session screen onto the Sessions tab; the back button pops cleanly; the terminal mounts exactly once and disconnects on pop. (URL-scheme path is testable now.) [owner:e2e-engineer] [beads:nx-2kxl3]
- [ ] 3.3 Manual: with the macOS PtyViewer attached to a session, open that session's iOS attach and type — keys reach the PTY and the macOS viewer flips to its read-only badge. Capture the agent `NXPTY interact open: writer-claim result` line (`claimed:true` for the iOS open). The notification-tap→pushed-view path is verification-blocked on APNS provisioning `nx-gsgvk`. [owner:e2e-engineer] [beads:nx-kwq1w]
