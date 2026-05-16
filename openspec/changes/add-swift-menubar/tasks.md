# Tasks · add-swift-menubar

<!-- beads:epic:nx-rxlbi -->
<!-- beads:feature:nx-xp2q4 -->

## UI Batch

- [x] 1.1 Replace `WindowGroup { ContentView() }` in `apps/swift/nexus/nexus/nexusApp.swift` with [beads:nx-barbd]
  `MenuBarExtra { NexusPanel() } label: { StatusIcon() }.menuBarExtraStyle(.window)`. Delete
  `ContentView.swift` and `Item.swift` (the Xcode template's SwiftData example).

- [x] 1.2 Build `StatusIcon` view: 3-bar SwiftUI `Canvas` glyph that swaps fill color based on [beads:nx-5zjyu]
  an `@Environment` aggregate state enum (ACTIVE / IDLE / STALE / UNREACHABLE). TTS-mute overlay
  composes via a `.overlay` modifier with a diagonal slash `Path`.

- [x] 1.3 Implement `AggregateState` model + `NexusClient` actor. Actor holds `peers`, `sessions`, [beads:nx-xu6bx]
  `metrics`, `notifications`. Computes aggregate state from peer reachability + session count.
  Exposes `@Published` properties for SwiftUI subscription.

- [x] 1.4 Wire SSE client in `NexusClient`. URLSession streaming task against [beads:nx-g2fco]
  `http://localhost:7400/events/stream`. Parse SSE frames; route events:
  `RemoteSessionStarted`, `RemoteSessionEnded`, `HomelabHeartbeat`, `PeerLost`,
  `NotificationFired`. Reconnect with exponential backoff (1s → 30s cap).

- [x] 1.5 Build `NexusPanel` view: 320-pt wide `VStack` with six locked regions — [beads:nx-91qfm]
  `IdentityRow`, `AlertStrip` (conditional), `MetricsRow`, `SessionList`, `ActionRow`. Use
  `.frame(width: 320)` and `.menuBarExtraStyle(.window)` chrome.

- [x] 1.6 Build `IdentityRow` view: 28×28 avatar gradient + homelab name + status sub-line [beads:nx-8vojw]
  (heartbeat delta + session count). `⋯` button trailing-right opens Preferences scene.

- [x] 1.7 Build `AlertStrip` view: amber for recoverable errors (ElevenLabs 401), red for [beads:nx-xzyf7]
  critical (homelab unreachable). Renders only when `nexusClient.alert != nil`. Action verb on
  the right side fires the relevant resolution path.

- [x] 1.8 Build `MetricsRow` view: two `Sparkline` charts (CPU + RAM) in a 2-column grid. [beads:nx-qf30y]
  Each `Sparkline` is a SwiftUI `Canvas` rendering 21 data points over a 120×32 viewBox.
  Polls `GET /health/history?hours=0.167` on mount; updates from `HomelabHeartbeat` SSE events.

- [x] 1.9 Build `Sparkline` reusable view: takes `[Double] values`, a `Color`, a [beads:nx-t0gcc]
  `LinearGradient` fill, and `isStale: Bool`. Renders polyline + gradient area + end-point dot.
  Applies 40% opacity + `STALE <mm:ss>` overlay when `isStale`.

- [x] 1.10 Build `SessionList` view: filters `nexusClient.sessions` to `agent == "homelab"` [beads:nx-hwb2d]
  client-side. Renders `SessionRow` for each. Empty state shows the `⌃⌥H spawns` hint.

- [x] 1.11 Build `SessionRow` view: 14-pt project sigil + title + meta line + age delta. [beads:nx-isbbp]
  Active sessions get phosphor-filled sigil with glow shadow. Click selects; `↩` triggers ATTACH.

- [x] 1.12 Build `ActionRow` view: 3-column grid — `AttachButton`, `NotifyButton`, `TtsButton`. [beads:nx-c0i77]
  Buttons share a base style; each owns its own popover state.

- [x] 1.13 Implement `AttachButton`: single-action button. On click, resolves the selected [beads:nx-bwwej]
  session's tmux window name (from `session.tmuxWindow` field, falling back to
  `"\(session.project)-\(session.startedAt.timeIntervalSince1970 * 1000)"`), then runs
  `Process()` with `/usr/bin/open -na Ghostty.app --args -e "ssh -t nyaptor@homelab tmux attach
  \\; select-window -t \(windowName)"`. Disabled when no session highlighted.

- [x] 1.14 Implement `NotifyButton` + popover: bell glyph with unread dot. Popover shows [beads:nx-xykfd]
  `nexusClient.notifications` (last 50, in-memory `Deque`). Each row: body + meta line. Click
  row → POST replay to `/notifications/send`. `CLEAR` button empties buffer + clears
  NSUserDefaults persistence key.

- [x] 1.15 Implement `TtsButton` + popover: waveform glyph (color = mode). Popover shows [beads:nx-cpcr7]
  current mode header + 3 control rows (Mute / Switch provider / Test voice) + live waveform
  preview when active. All controls POST to `/notifications/settings` or `/notifications/send`.

- [x] 1.16 Implement notifications persistence: `UserDefaults.standard.suite("com.nexus.menubar")` [beads:nx-d83ap]
  with key `nx.menubar.notifications.history`. Serialize to JSON on every buffer change;
  hydrate on app launch.

- [x] 1.17 Implement global hotkey registration: wrap `RegisterEventHotKey` in a [beads:nx-35hvu]
  `GlobalHotkeyManager` class. Register `⌃⌥N` (summon panel) and `⌃⌥H` (spawn homelab session).
  Both fire via `NSEvent.addGlobalMonitorForEvents` for in-app + global coverage.

- [x] 1.18 Implement `SpawnHomelabSession` flow: on `⌃⌥H`, POST to `/session/start` with the [beads:nx-y7n66]
  currently-selected project (default `nx`, path `/home/nyaptor/dev/<code>`). On response,
  call the same Ghostty launcher as ATTACH with the new `sessionId`.

- [x] 1.19 Build `Preferences` scene: separate `Scene` registered alongside `MenuBarExtra`. [beads:nx-fkqkv]
  Form-style layout. Sections: Hotkeys (rebind), TTS defaults, Autostart toggle, Theme density.
  All values backed by `@AppStorage` against the `com.nexus.menubar` suite.

- [x] 1.20 Implement autostart installer: on first launch (no `nx.menubar.firstRun` key), [beads:nx-73dfm]
  show a one-shot `NSAlert` asking to install LaunchAgent. On accept (or Preferences toggle),
  write templated plist + run `launchctl bootstrap gui/$(id -u) <plist>`. On disable, run
  `launchctl bootout` + delete plist.

- [x] 1.21 Bundle JetBrains Mono font: add `JetBrainsMono-Regular.ttf` + `Medium` + [beads:nx-0v74c]
  `SemiBold` to the Xcode project's resource group. Register via `UIAppFonts` in `Info.plist`.
  Create a `Font.jbm(_: weight:)` extension for ergonomic call sites.

- [x] 1.22 Build a `Theme` extension on `Color` mirroring the wireframe tokens (substrate, [beads:nx-356mo]
  hairline, phosphor, amber, critical, ink scale). All views use `Color.nx.phosphor` etc.

- [x] 1.23 Apply NSVisualEffectView backdrop: wrap `NexusPanel` content in a custom [beads:nx-kcb5t]
  `NSViewRepresentable` that hosts an `NSVisualEffectView` with material `.hudWindow` and
  blending `.behindWindow`. Layer the gradient + grain texture on top.

- [x] 1.24 Implement animation budget: `pulse` on the unread badge (2 s easeInOut, repeat [beads:nx-k2lzq]
  forever), `fade+slide` for new session rows (160 ms), `split-flap` digit animation on KPI
  values (90 ms per digit). Honor `accessibilityReduceMotion` — disable all three when set.

- [x] 1.25 Wire keyboard navigation: arrow keys move focus through `SessionList`. `↩` = [beads:nx-toi98]
  ATTACH highlighted row. `Esc` dismisses panel. `2` / `3` = NOTIFY / TTS buttons.
  `⌘,` opens Preferences.

## E2E Batch

- [x] 2.1 Swift unit test (`nexusTests/GhosttyLauncherTests.swift`): mock `Process()`, assert [beads:nx-qimoc]
  the launcher invokes `/usr/bin/open` with exactly the expected argv (including `-na`,
  `Ghostty.app`, `--args`, `-e`, and the full quoted SSH command with tmux verbs).

- [x] 2.2 Swift unit test (`nexusTests/TmuxWindowNameTests.swift`): given a `Session` with a [beads:nx-qghm8]
  known `id`, `project`, and `startedAt`, assert window-name resolution produces the canonical
  `<project>-<timestamp>` format and matches the agent's naming in
  `apps/agent/src/routes/sessions.ts:239`.

- [x] 2.3 Swift unit test (`nexusTests/SSEEventParsingTests.swift`): feed fixture SSE byte [beads:nx-sugfu]
  streams for all 5 event types (`RemoteSessionStarted`, `RemoteSessionEnded`,
  `HomelabHeartbeat`, `PeerLost`, `NotificationFired`); assert `NexusClient` mutates the
  expected observable properties.

- [x] 2.4 Swift unit test (`nexusTests/AggregateStateTests.swift`): table-driven test covering [beads:nx-759fd]
  every combination of `peerReachable`, `sessionCount`, `ttsEnabled`. Assert the derived
  `AggregateState` matches the wireframe's 5 variants (ACTIVE / IDLE / STALE / UNREACHABLE /
  +TTS-MUTED overlay).

- [x] 2.5 Swift unit test (`nexusTests/NotificationRingBufferTests.swift`): exercise the [beads:nx-1ghm9]
  in-memory ring buffer at sizes 0, 1, 50, 51 (one over capacity). Assert FIFO eviction, JSON
  round-trip through NSUserDefaults, and `CLEAR` semantics.

- [x] 2.6 Swift unit test (`nexusTests/LaunchAgentInstallerTests.swift`): mock `launchctl` and [beads:nx-h8o1k]
  filesystem; assert install writes the templated plist to the expected path and invokes
  `launchctl bootstrap` with the right domain. Assert uninstall runs `bootout` + removes plist.

- [x] 2.7 Swift UI test (`nexusUITests/PanelSummonTests.swift`): launch app headlessly, [beads:nx-h9jag]
  simulate `⌃⌥N` press, assert the panel becomes visible within 500 ms. Press `Esc`, assert
  it dismisses.

- [ ] 2.8 [user] Manual smoke flow: fresh install on the Mac. Click ATTACH on a homelab [beads:nx-7oa63]
  session; verify Ghostty opens to the correct tmux window. Press `⌃⌥H`; verify a new session
  spawns and attaches. Toggle TTS mute; verify the icon overlay appears AND a subsequent
  `nx_notify` from the shell is silent. Toggle autostart; verify
  `~/Library/LaunchAgents/com.nexus.menubar.plist` is written and `launchctl list` shows the
  agent loaded.

- [ ] 2.9 [user] Verify the wireframe still matches the implementation: open [beads:nx-3hv0r]
  `docs/wireframes/nexus-menubar/index.html` side-by-side with the built app; flag any
  visual deltas. Update the wireframe (not the app) if minor; raise a follow-up spec if major.
