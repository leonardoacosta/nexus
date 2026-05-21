# swift-menubar-client Delta

## ADDED Requirements

### Requirement: settings-split-view-shell
The Settings tab MUST render a `NavigationSplitView` with a left sidebar listing five categories (`TTS & Audio`, `Notifications`, `Agents`, `Dashboard`, `Diagnostics`) and a right detail pane. Selection MUST persist via `@AppStorage("settings.sidebar.selection")` with default `tts` on first launch. The detail pane MUST swap between five dedicated views (one per category) based on selection. The previous flat-form layout MUST NOT be reachable.

#### Scenario: default category on fresh launch
- **Given** no @AppStorage entry exists for the sidebar selection
- **When** the Settings tab opens
- **Then** the sidebar highlights `TTS & Audio`; the detail pane renders `SettingsTtsView`

#### Scenario: selection persists
- **Given** the user clicked `Diagnostics` in a previous session
- **When** the app relaunches and the user opens Settings
- **Then** the sidebar highlights `Diagnostics`; `SettingsDiagnosticsView` renders without re-clicking

#### Scenario: legacy form unreachable
- **Given** the redesign is in place
- **When** the user navigates to Settings via any entry point (sidebar, menu bar, Cmd+,)
- **Then** the NavigationSplitView shell renders; no code path reaches the old four-section Form

### Requirement: settings-tts-category
The `SettingsTtsView` MUST contain four logical blocks: (1) TTS toggles — `tts_enabled`, `banner_enabled`, ducking mode picker, signal-only toggle (each backed by existing persistence keys, verbatim); (2) ElevenLabs key panel — masked-show field for the Keychain key, paste field for replacement, Test button, Save button; (3) Global voice id — text field backed by `Keychain.elevenLabsVoiceId`; (4) Per-project voices — mount the `ProjectVoicesView` from `notifications-overhaul` inline. The separate `ElevenLabsSettingsView.swift` MUST be removed from the project after consolidation.

#### Scenario: TTS toggles backed by existing keys
- **Given** the previous session had `tts_enabled = false` persisted
- **When** the user opens TTS & Audio
- **Then** the toggle is OFF (the same persistence key resolves to the same value — no settings reset)

#### Scenario: key paste replaces Keychain entry
- **Given** Keychain has key `old-key`
- **When** the user types `new-key` into the paste field and clicks Save
- **Then** Keychain now holds `new-key`; the masked-show field reflects the new value

#### Scenario: per-project voices mounted inline
- **Given** the `ProjectVoicesView` exists (from notifications-overhaul)
- **When** SettingsTtsView renders
- **Then** the per-project editor appears as the fourth block, fully functional (add/edit/delete project voice overrides)

#### Scenario: ElevenLabsSettingsView absent
- **When** the codebase is searched for `ElevenLabsSettingsView`
- **Then** zero references exist outside this proposal's archive folder

### Requirement: settings-agents-config-editor
The `SettingsAgentsView` MUST render `~/.config/nexus/agents.toml` as an editable list: one row per `[[agents]]` entry showing `name`, `endpoint`, and `machine` columns. The view MUST provide Add, Edit (inline), and Delete affordances. Save MUST write the file atomically (`.tmp + rename` pattern, same as `/triage` frontmatter). After a successful save, the view MUST post a `NotificationCenter` notification `AgentsConfigChanged` that `NexusAggregateClient` subscribes to and reacts by rebootstrapping the per-agent client list.

#### Scenario: edit existing entry
- **Given** agents.toml contains `[[agents]] name = "homelab" endpoint = "http://100.73.182.4:7400" machine = "homelab"`
- **When** the user changes endpoint to `http://100.73.182.5:7400` and clicks Save
- **Then** the file is rewritten with the new endpoint; the row reflects the new value; an `AgentsConfigChanged` notification posts

#### Scenario: add new entry
- **Given** agents.toml has one entry
- **When** the user clicks Add, fills `name = "remote", endpoint = "http://10.0.0.5:7400", machine = "remote-mac"`, and saves
- **Then** the file gains a second `[[agents]]` table; both rows render

#### Scenario: invalid endpoint refused inline
- **When** the user types `not-a-url` into the endpoint field
- **Then** the row's Save button is disabled; a small caption reads "endpoint must be a URL"; no write occurs

#### Scenario: NexusAggregateClient rebootstraps live
- **Given** the dashboard is showing data from agents.toml's two entries
- **When** the user adds a third entry and saves
- **Then** within 2 seconds the dashboard reflects fan-out across all three agents (no app relaunch required)

#### Scenario: parse failure falls back to raw editor
- **Given** agents.toml exists but contains malformed TOML (manual edit went wrong)
- **When** SettingsAgentsView loads
- **Then** the structured editor is hidden; a "Raw TOML editor (file is invalid)" pane renders with the file contents in a text editor; saving from the raw editor re-attempts parse on next open

### Requirement: settings-diagnostics-pane
The `SettingsDiagnosticsView` MUST surface a read-only key/value list summarising agent health: last health-snapshot timestamp + age, last process-watcher tick + age (traffic-light: green <30s, yellow <2min, red >2min), socket-spine listening boolean, db_ok boolean, dashboard build SHA, agent build SHA (when available), agents.toml entry count. The pane MUST provide a "Copy diagnostics to clipboard" button that formats the data as plain text under a `nexus diagnostics — <ISO-date>` header. Before copying, the button MUST show a confirmation dialog with the exact payload so the operator reviews before clipboard write.

#### Scenario: fresh diagnostics
- **Given** the agent ticked health 5 seconds ago and watcher 12 seconds ago
- **When** SettingsDiagnosticsView renders
- **Then** both age indicators are green; values read `5s ago` and `12s ago`

#### Scenario: stale watcher
- **Given** watcher last ticked 3 minutes ago
- **When** the pane renders
- **Then** the watcher row indicator is red; value reads `3m 0s ago`

#### Scenario: copy with confirmation
- **Given** the pane is populated
- **When** the user clicks "Copy diagnostics to clipboard"
- **Then** a confirmation dialog renders the exact payload with Copy / Cancel buttons; only Copy writes to `NSPasteboard.general`

### Requirement: settings-persistence-key-migration
The refactor MUST preserve every existing `@AppStorage` / Keychain / UserDefaults key in use today. A one-time launch-side migration check MUST read each expected key after the redesign ships and log a warn-level message if any are missing (indicating a regression). The check MUST NOT mutate any keys; it is observational only.

#### Scenario: all keys preserved
- **Given** the user had `tts_enabled = false, banner_enabled = true, ducking = duck, refresh_interval = 15` from before the redesign
- **When** the redesign ships and the user relaunches
- **Then** TTS & Audio shows TTS off + banners on + duck mode; Dashboard shows refresh interval 15s; no values are reset

#### Scenario: missing key flagged
- **Given** a hypothetical regression where a key is renamed unintentionally
- **When** the launch-side migration check runs
- **Then** a warn-level pino log entry is written: `expected settings key 'X' not found post-redesign` — no UI alert, no reset
