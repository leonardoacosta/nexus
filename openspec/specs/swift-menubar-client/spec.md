# swift-menubar-client Specification

## Purpose
TBD - created by archiving change add-swift-menubar. Update Purpose after archive.
## Requirements
### Requirement: Menu bar icon reflects aggregate homelab state

The macOS menu bar SHALL display a single 22-pixel icon that encodes the current Nexus state in
five discrete visual variants. The icon SHALL update in-place when the underlying state changes;
it SHALL NOT add or remove itself from the menu bar in response to state changes.

The five variants correspond to mutually exclusive conditions:

| Variant | Condition |
| --- | --- |
| ACTIVE | homelab reachable AND ≥1 remote session running |
| IDLE | homelab reachable AND zero remote sessions |
| STALE | homelab last-heartbeat > 30s and < 5min |
| UNREACHABLE | homelab last-heartbeat > 5min OR explicit connection failure |
| TTS-MUTED | overlay (diagonal slash) — composes with any of the above |

#### Scenario: Homelab transitions from idle to active

- **WHEN** a `RemoteSessionStarted` SSE event arrives and the previous state was IDLE
- **THEN** the menu bar icon SHALL repaint to the ACTIVE variant (phosphor-filled bars) within
  500 ms of the event
- **AND** the icon's `accessibilityLabel` SHALL update to reflect the new aggregate state

#### Scenario: Homelab becomes unreachable

- **WHEN** no heartbeat has been received from homelab for more than 5 minutes (300s)
- **OR** the agent's federation channel reports `PeerLost` for homelab
- **THEN** the menu bar icon SHALL repaint to the UNREACHABLE variant (red bars)
- **AND** the panel SHALL render the critical alert strip with a time-since counter when opened

#### Scenario: TTS-muted overlay composes with any state

- **WHEN** TTS is muted (locally or via `/notifications/settings`)
- **AND** homelab is in any reachable state (ACTIVE / IDLE / STALE)
- **THEN** the menu bar icon SHALL render the base variant PLUS the diagonal-slash overlay
- **AND** when TTS is unmuted, the overlay SHALL be removed without changing the base variant

---

### Requirement: Panel summons via click or global hotkey

The panel SHALL open from two sources: a left-click on the menu bar icon, or the global hotkey
`⌃⌥N` from any focused application.

#### Scenario: Click on menu bar icon

- **WHEN** the user left-clicks the menu bar icon
- **THEN** the 320-pixel-wide panel SHALL appear, anchored to the icon
- **AND** the panel SHALL receive keyboard focus
- **AND** the first session row (if any) SHALL be the initial focus target

#### Scenario: Global hotkey while in another app

- **WHEN** the user presses `⌃⌥N` while any application has focus
- **THEN** the menu bar app SHALL be activated and the panel SHALL appear
- **AND** the previously-focused application SHALL be restored when the panel dismisses

#### Scenario: Panel dismisses on Escape

- **WHEN** the panel is open and focused
- **AND** the user presses `Escape` (or clicks outside the panel)
- **THEN** the panel SHALL dismiss
- **AND** focus SHALL return to the previously-focused application

---

### Requirement: Panel shows live homelab CPU + RAM sparklines

The panel SHALL display two side-by-side sparkline charts showing the last 10 minutes of CPU and
RAM utilization on homelab. The data SHALL come from `GET /health/history?hours=0.167` on the
local agent (which aggregates homelab via federation).

#### Scenario: Sparklines update on heartbeat

- **WHEN** the panel is open
- **AND** a `HomelabHeartbeat` SSE event arrives with new CPU/RAM samples
- **THEN** each sparkline SHALL append the new point and shift the oldest point off
- **AND** the current value label SHALL update without a layout reflow
- **AND** the dot at the right edge of the sparkline SHALL re-anchor to the new point

#### Scenario: Sparklines freeze when homelab unreachable

- **WHEN** homelab transitions to UNREACHABLE
- **AND** the panel is open
- **THEN** each sparkline SHALL render with 40% opacity
- **AND** an overlay reading `STALE <mm:ss>` SHALL appear on each chart
- **AND** the last-known value label SHALL gray out (no further updates)

#### Scenario: Idle state shows graphite stroke

- **WHEN** homelab is IDLE (reachable, no active sessions)
- **THEN** each sparkline SHALL render with graphite stroke (`#7A8088`) rather than phosphor
- **AND** the gradient fill SHALL use `--grad-muted` instead of `--grad-phosphor`

---

### Requirement: Remote sessions list shows only homelab-originated sessions

The panel SHALL display a list of Claude Code sessions that originated on homelab. Sessions
that originated on the local Mac SHALL NOT appear in this list.

Each row SHALL show: a 14-px project sigil, the session title, a project code + model meta line,
and an age delta right-aligned.

#### Scenario: Filter excludes local sessions

- **WHEN** `GET /sessions` returns N sessions
- **AND** K of those sessions have `agent == "macbook"`
- **THEN** the list SHALL render exactly N − K rows
- **AND** the count chip in the section header SHALL show `N − K LIVE`

#### Scenario: Active session shows filled sigil

- **WHEN** a session's `status == "active"` (last heartbeat < 30s)
- **THEN** that row's sigil SHALL render with phosphor fill + phosphor glow
- **AND** other sessions' sigils SHALL render with stroke-only outline

#### Scenario: Empty list invites spawn

- **WHEN** zero homelab sessions are running and homelab is reachable
- **THEN** the session-list region SHALL render the empty state: `no claude code on homelab`
  with `⌃⌥H spawns a session there` as a hint
- **AND** the ATTACH button SHALL be disabled (40% opacity)

---

### Requirement: ATTACH action launches Ghostty + SSH + tmux

The ATTACH button (action row position 1) SHALL be a single-action button. Clicking it SHALL
open Ghostty.app to the exact tmux window where the highlighted session is running.

#### Scenario: Click ATTACH on an active session

- **WHEN** a session is highlighted in the list
- **AND** the user clicks the ATTACH button (or presses `↩` while a row is focused)
- **THEN** the app SHALL resolve the tmux window name by reading `session.tmuxWindow` (or by
  reconstructing `<project>-<timestamp>` from `session.id`)
- **AND** the app SHALL execute:
  `open -na Ghostty.app --args -e "ssh -t nyaptor@homelab tmux attach \; select-window -t <name>"`
- **AND** Ghostty SHALL become the foreground app

#### Scenario: ATTACH disabled when no session selected

- **WHEN** the session list is empty
- **OR** no row is focused
- **THEN** the ATTACH button SHALL render at 40% opacity with `pointer-events: none`
- **AND** keyboard `↩` SHALL not trigger the launcher

#### Scenario: Ghostty launch failure surfaces error

- **WHEN** the `open -na Ghostty.app …` invocation exits non-zero (e.g., Ghostty.app missing)
- **THEN** the app SHALL surface a non-blocking inline error: `Ghostty.app not found at
  /Applications/Ghostty.app` with a `OPEN APP STORE` action
- **AND** the panel SHALL remain open

---

### Requirement: NOTIFY action shows notification history

The NOTIFY button (action row position 2) SHALL open a popover containing the last 50
notifications received by this Mac during the current session, with persistence across launches
via `NSUserDefaults`.

#### Scenario: New NotificationFired event prepends to history

- **WHEN** a `NotificationFired` SSE event arrives
- **THEN** the event SHALL be prepended to the in-memory history ring buffer
- **AND** if the buffer exceeds 50 entries, the oldest entry SHALL be dropped
- **AND** the NOTIFY button's unread dot SHALL pulse (1s breath) and remain visible until the
  popover is opened

#### Scenario: Replay a notification row

- **WHEN** the user clicks a row in the NOTIFY popover
- **THEN** the app SHALL POST the original payload to `/notifications/send` on the local agent
- **AND** the row SHALL flash phosphor for 200 ms to confirm replay

#### Scenario: Clear history

- **WHEN** the user clicks `CLEAR` in the popover header
- **THEN** the in-memory ring buffer SHALL be emptied
- **AND** the NSUserDefaults persistence key `nx.menubar.notifications.history` SHALL be set
  to an empty array
- **AND** the popover SHALL re-render with the empty state

---

### Requirement: TTS action exposes audio pipeline controls

The TTS button (action row position 3) SHALL open a popover with three controls: mute, switch
provider, test voice. State changes SHALL POST to `/notifications/settings` on the local agent
so the bash listener also picks them up.

#### Scenario: Toggle mute via popover or hotkey

- **WHEN** the user clicks `Mute` in the popover (or presses `⌘M` anywhere in the app)
- **THEN** the app SHALL POST `{ "tts_enabled": false }` to `/notifications/settings`
- **AND** the menu bar icon SHALL apply the TTS-MUTED overlay
- **AND** the TTS button's waveform glyph SHALL render in graphite

#### Scenario: Switch to local say()

- **WHEN** the user clicks `Switch to local say()` in the popover
- **THEN** the app SHALL POST `{ "tts_provider": "say" }` to `/notifications/settings`
- **AND** the popover header SHALL update to `via local say()` with an amber state dot

#### Scenario: Test voice plays a short phrase

- **WHEN** the user clicks `Test voice` in the popover (or presses `⌘T`)
- **THEN** the app SHALL POST a synthetic notification payload
  (`{ "body": "TTS test from menu bar", "channel": "tts" }`) to `/notifications/send`
- **AND** the popover SHALL display a live waveform animation for 1.5 s

---

### Requirement: Global hotkey ⌃⌥H spawns a homelab session

The app SHALL register a global hotkey `⌃⌥H` that, regardless of the foreground application,
spawns a fresh Claude Code session on homelab via `POST /session/start` and immediately attaches
the new session in Ghostty.

#### Scenario: Spawn from another app

- **WHEN** the user presses `⌃⌥H` while another application is in the foreground
- **THEN** the app SHALL determine the current project (from the menu bar's selected target, or
  default to `nx`) and POST `{ "project": "<code>", "path": "/home/nyaptor/dev/<code>" }` to
  `/session/start` on the local agent
- **AND** upon receiving the new `sessionId` in the response, the app SHALL execute the same
  Ghostty launcher pattern as the ATTACH action
- **AND** Ghostty SHALL become the foreground app with the new session ready

---

### Requirement: Autostart on login

On first launch, the app SHALL prompt the user to install a `com.nexus.menubar.plist`
LaunchAgent under `~/Library/LaunchAgents/`. If the user accepts, the agent SHALL be installed
and registered via `launchctl bootstrap`. The user SHALL be able to toggle this state from
Preferences afterwards.

#### Scenario: First-run autostart prompt

- **WHEN** the app launches for the first time (no `nx.menubar.firstRun` key in NSUserDefaults)
- **THEN** the app SHALL display a one-shot prompt: `Launch Nexus at login?` with options
  `Install` / `Not now`
- **AND** the prompt SHALL not appear on subsequent launches regardless of the user's choice

#### Scenario: Install LaunchAgent

- **WHEN** the user accepts the autostart prompt (or toggles autostart ON in Preferences)
- **THEN** the app SHALL write a templated plist to
  `~/Library/LaunchAgents/com.nexus.menubar.plist` pointing at the app's installed path
- **AND** the app SHALL run `launchctl bootstrap gui/$(id -u) <plist>` to register the agent
- **AND** the Preferences toggle SHALL reflect the new state

#### Scenario: Uninstall LaunchAgent

- **WHEN** the user toggles autostart OFF in Preferences
- **THEN** the app SHALL run `launchctl bootout gui/$(id -u)/com.nexus.menubar`
- **AND** the app SHALL delete `~/Library/LaunchAgents/com.nexus.menubar.plist`

---

### Requirement: Preferences scene backed by NSUserDefaults

The app SHALL expose a Preferences scene reachable via the `⋯` glyph in the panel's identity row
(or `⌘,` when the panel is focused). Preferences state SHALL persist via `NSUserDefaults` under
the suite name `com.nexus.menubar`.

The Preferences scene SHALL include at minimum:

- Hotkeys section (rebind `⌃⌥N` summon, `⌃⌥H` spawn, `⌘M` mute, `⌘T` test voice)
- TTS section (default provider, default voice ID)
- Autostart toggle
- Theme density (compact / regular)

#### Scenario: Preference change persists across launches

- **WHEN** the user changes any preference value
- **AND** the app is quit and relaunched
- **THEN** the new value SHALL be the active value on next launch
- **AND** any UI affected by the preference SHALL reflect the persisted value within 1 frame
  of launch

#### Scenario: Hotkey rebind takes effect immediately

- **WHEN** the user rebinds a global hotkey in Preferences
- **THEN** the old binding SHALL be unregistered within 100 ms
- **AND** the new binding SHALL be registered within 100 ms
- **AND** both events SHALL happen atomically (no window where neither is registered)

### Requirement: SpecsView presents a two-column layout with markdown detail

The Nexus.app SpecsView SHALL present a two-column layout: the existing
project-grouped spec list on the left, a markdown-rendered detail pane
on the right. The detail pane MUST load the selected spec's proposal,
design (if present), and tasks markdown via the agent's HTTP API.

#### Scenario: selecting a spec loads its proposal

- **GIVEN** the SpecsView is open with at least one spec listed
- **WHEN** the user clicks a spec row
- **THEN** the detail pane fetches `proposal.md` for that spec
- **AND** the content renders as formatted markdown (bold, italic,
  inline code, links applied)

#### Scenario: detail pane tabs switch between proposal/design/tasks

- **GIVEN** a spec is selected and its detail pane is visible
- **WHEN** the user clicks the "design" tab
- **THEN** the pane fetches and renders `design.md` for that spec
- **AND** the tab indicator reflects the active document

#### Scenario: missing file shows empty state

- **GIVEN** a spec has no `design.md`
- **WHEN** the user clicks the "design" tab
- **THEN** the pane shows an empty state ("No design document for
  this spec") without throwing
- **AND** the markdown renderer is NOT invoked with empty content

#### Scenario: no spec selected shows hint state

- **GIVEN** no spec is selected
- **WHEN** the user opens the Specs tab for the first time
- **THEN** the detail pane shows a hint ("Select a spec to view its
  contents")
- **AND** the column proportions remain stable

### Requirement: Agent exposes spec content via dedicated endpoint

The agent SHALL serve markdown file content via
`GET /specs/{project}/{name}/{file}` where `file` is one of
`proposal`, `design`, `tasks` (without extension). The handler MUST
sanitize paths (reject `..`, enforce the canonical
`<workspace-root>/<project>/openspec/changes/<spec>/<file>.md`
pattern).

#### Scenario: valid request returns markdown bytes

- **GIVEN** `~/dev/nx/openspec/changes/foo/proposal.md` exists
- **WHEN** the dashboard fetches `GET /specs/nx/foo/proposal`
- **THEN** the response status is 200
- **AND** the body is the file's raw markdown content
- **AND** the Content-Type header is `text/markdown; charset=utf-8`

#### Scenario: traversal attempt is rejected

- **WHEN** a request like `GET /specs/nx/foo/../../etc/passwd`
  reaches the handler
- **THEN** the response status is 400 (bad request)
- **AND** no filesystem access occurs outside the workspace root

#### Scenario: missing spec returns 404

- **WHEN** a request for a non-existent spec is made
- **THEN** the response is 404 with a small JSON body
  `{"error":"not found"}`
- **AND** the handler does NOT leak filesystem error details

### Requirement: NotificationsView places settings as a bottom toolbar

The NotificationsView SHALL use a `VStack` layout: the history list
(full window width) above, a compact horizontal settings toolbar
pinned to the bottom. The `HSplitView` settings-pane allocation MUST
NOT consume horizontal real-estate from the body.

#### Scenario: notification body uses full width

- **GIVEN** the NotificationsView is visible at a 700px window width
- **WHEN** a notification arrives with a 200-character body
- **THEN** the body text wraps using the full window width (minus
  standard padding)
- **AND** the body is NOT truncated mid-sentence by a narrow column

#### Scenario: bottom toolbar exposes all settings

- **GIVEN** the NotificationsView is visible
- **WHEN** the user looks at the bottom of the panel
- **THEN** the toolbar contains: Mode picker (Mix/Meet), Signal-only
  toggle, Suppression stepper (0m default), Ducking menu
- **AND** all controls remain functional and bound to the same
  underlying model as before

#### Scenario: toolbar fits in a narrow window

- **WHEN** the window is resized down to 480px wide
- **THEN** the toolbar controls remain visible (compact icons + short
  labels) without horizontal scrolling
- **AND** the body pane shrinks proportionally without breaking layout

### Requirement: SystemSpeechSynthesizer serializes utterances

The `SystemSpeechSynthesizer` SHALL serialize concurrent `speak()`
calls. Each call MUST await the prior `/usr/bin/say` subprocess's
exit before launching the next. Three rapid calls produce three
sequential utterances, NOT three overlapping ones.

#### Scenario: rapid speak calls produce sequential audio

- **GIVEN** SystemSpeechSynthesizer is freshly instantiated
- **WHEN** three `speak()` calls fire within 100ms (text: "alpha",
  "bravo", "charlie")
- **THEN** the audio output produces "alpha" first (in full), then
  "bravo" (in full), then "charlie" — never overlapping
- **AND** the total wall-clock equals the sum of the three utterance
  durations

#### Scenario: speak returns immediately, work is queued

- **WHEN** `speak("hello")` is called
- **THEN** the function call returns within 10ms (does NOT block on
  audio completion)
- **AND** the audio begins playing within the next 100ms (subprocess
  spawn latency)

#### Scenario: subprocess failure does not stall the queue

- **WHEN** a `/usr/bin/say` invocation fails (e.g., empty argument
  vector)
- **THEN** the error is logged via os_log
- **AND** the next queued utterance still runs
- **AND** the queue does NOT permanently jam

