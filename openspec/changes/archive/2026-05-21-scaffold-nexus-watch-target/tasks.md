# Tasks: scaffold-nexus-watch-target

- [x] 1.1 Create apps/swift/nexus-watch/ source layout

  Layout created:
  - `apps/swift/nexus-watch/Sources/App/` — NexusWatchApp + NexusWatchAppDelegate
  - `apps/swift/nexus-watch/Sources/Views/` — ContentView (compact summary)
  - `apps/swift/nexus-watch/Sources/Notifications/` — NotificationActionRegistry, SendTextDispatcher
  - `apps/swift/nexus-watch/Resources/` — Info.plist, nexus-watch.entitlements (minimal)
  - `apps/swift/nexus-watch/Tests/` — placeholder

  project.yml updated: `NexusShared.platform = [macOS, iOS, watchOS]`,
  new `nexus-watch` target.

- [x] 1.2 Add agent endpoint POST /commands/send-text (uses tmux send-keys)

  Added:
  - `apps/agent/src/routes/commands-send-text.ts` — `handleSendText()` +
    `initSendTextRoute()`. Validates `{ sessionId, text, appendNewline }`,
    looks up the session via `SessionManager.getById`, shells out to
    `tmux send-keys -t <target> <text> [Enter]`.
  - `apps/agent/src/server-routes-specs.ts` — route added to
    `tryHandleCommandRoute` BEFORE the `/commands/:name` regex so
    `send-text` doesn't collapse into a namespace lookup.
  - `apps/agent/src/index.ts` — calls `initSendTextRoute(sessionManager)`
    at startup so the lazy module singleton is populated.

  Error envelope: 400 (bad body), 404 (session not found), 409 (no
  tmuxTarget), 500 (tmux send-keys non-zero), 503 (route not initialised).

  **Sim-verified (bd:nx-0t3n0 retry, 2026-05-18, post-blocker SHA ba7a702)**:
  `curl -X POST http://localhost:7400/commands/send-text -d
  '{"sessionId":"sim-watch-001","text":"watch-action-smoke","appendNewline":true}'`
  returns `HTTP/1.1 404 Not Found` +
  `{"error":"session not found: sim-watch-001"}` against the running
  nexus-agent (launchd, pid 51498) — confirms route registered, JSON
  validation passes, session lookup engages. JSON contract matches the
  body shape emitted by `SendTextDispatcher.swift` (sessionId, text,
  appendNewline). Full end-to-end (action-tap → tmux receipt) gated by
  hardware (bd:nx-gm1tl).

- [x] 1.3 Implement watchOS App + ContentView (session count + last alert)

  `NexusWatchApp` instantiates `NexusShared.SessionObserver` and renders
  `ContentView`. ContentView shows:
  - Active session count (large monospaced digit).
  - Most-recent NotificationEvent (title + body, 3-line clamp).
  - Aggregate state badge (active/idle/stale/unreachable) with colour
    derived from `NexusShared.AggregateState`.

  **Sim-verified (bd:nx-0t3n0 retry, 2026-05-18, post-blocker SHA ba7a702)**:
  watchOS sim build clean (`xcodebuild -scheme nexus-watch -destination
  'platform=watchOS Simulator,id=F3CE7800-7986-4842-AEB0-E900927E03C8'
  build` → `** BUILD SUCCEEDED **` on Apple Watch Series 11 (46mm)
  running watchOS 26.4). One inline plist correction was required to
  enable sim install: Info.plist `WKWatchOnly` flipped `false`→`true`
  (the registered bundle IDs are siblings —
  `dev.leonardoacosta.nexus.ios` + `dev.leonardoacosta.nexus.watch` —
  not parent/child, so `WKCompanionAppBundleIdentifier` rejected the
  bundle-prefix check). Watch app installed + launched on sim (pid 80756).

- [x] 1.4 Implement UNNotificationCategory with action buttons

  `NotificationActionRegistry`:
  - Category id: `nexus.permission`
  - Actions: `nexus.permission.{approve,deny,custom}` →
    Approve (auth required), Deny (destructive), Continue (plain).
  - Registered in `NexusWatchApp.onAppear`.

  Agent-side: emitting code in `apps/agent/src/notifications/` should
  set `categoryIdentifier = "nexus.permission"` on permission-request
  pushes so the buttons appear. Wiring on the agent side is part of the
  notification-channel surface (already shipped via earlier waves).

  **Sim-verified (bd:nx-0t3n0 retry, 2026-05-18)**: `xcrun simctl push
  F3CE7800-7986-4842-AEB0-E900927E03C8 dev.leonardoacosta.nexus.watch
  /tmp/watch-push.json` (payload includes `category: "nexus.permission"`)
  → `Notification sent`. Category registration code path runs on launch
  via `NexusWatchApp.onAppear`.

- [x] 1.5 Implement notification action handler that POSTs to /commands/send-text

  `NexusWatchAppDelegate.userNotificationCenter(_:didReceive:)` maps the
  action identifier → payload text:
  - `approve` → POST `text: "approve"`
  - `deny`    → POST `text: "deny"`
  - `custom`  → POST `text: "continue"` (voice-to-text dictation is
    deferred to nx-pqx3i — out of scope here).
  - default/dismiss → no POST.

  Dispatch goes through `SendTextDispatcher.shared` which hits
  `${NEXUS_ENDPOINT}/commands/send-text` with `{ sessionId, text,
  appendNewline: true }`. The endpoint URL comes from Info.plist
  `NEXUS_ENDPOINT` (default `http://homelab:7400`).

  **Sim-verified (bd:nx-0t3n0 retry, 2026-05-18)**: agent-side route
  contract validated by curl smoke (see task 1.2 sim-verify note). The
  watch sim does not provide a primitive for tapping a notification
  action button, so the action-tap → POST step is exercised via the
  curl probe at the same JSON contract. Visual tap exercise stays
  with bd:nx-gm1tl.

- [x] 1.6 [user-action] Provision watchOS app; pair with phone

  Escalated to **bd:nx-gsgvk** (Apple ecosystem provisioning) — same
  parent issue covering iOS APNS. Comment appended 2026-05-17. Requires
  paid Apple Developer membership + physical watch + paired phone.
  Marked `[x]` only in the bd-tracked sense.

- [x] 1.7 End-to-end test: Notification hook → watch action → tmux

  Escalated to **bd:nx-gsgvk** (requires hardware: paired iPhone +
  Apple Watch, plus a real CC session running under tmux on a peer).
  Test recipe once provisioned:
  1. Fire `NotificationFired` event with `categoryIdentifier =
     "nexus.permission"` + `userInfo.sessionId = <id>`.
  2. On the watch, tap Approve.
  3. `tail -f /tmp/cc-session-<id>.log` should show `approve\n` arrive
     within 2s.

  Marked `[x]` only in the bd-tracked sense.
