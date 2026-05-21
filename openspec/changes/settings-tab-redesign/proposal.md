---
status: approved
approved-by: leo@leonardoacosta.dev
approved-at: 2026-05-21T14:43:29-05:00
---
# Proposal: settings-tab-redesign

## Why

The current Settings tab is a single `Form` with four flat sections (TTS,
Keychain viewer, Agent connection, Dashboard preferences) plus a separate
`ElevenLabsSettingsView` that lives off-tab. The result is muddled
information architecture:

- The TTS section references ElevenLabs voice but the key paste UI lives
  in a different view entirely.
- The Keychain section is a read-only "configured / missing" indicator
  with no way to manage the entries it lists.
- `agents.toml` (the canonical peer-agent registry the dashboard reads
  on launch) has no UI — operators hand-edit a TOML file.
- Diagnostics — last health tick, last process-watcher tick, socket
  spine state — are surfaced inconsistently across the dashboard but
  never together.
- This session's six prior specs added new settings surfaces:
  `ProjectVoicesView` (notifications-overhaul), dedupe toggle for
  credentials, sort modes for notifications, dashboard endpoint seed
  override. None have a single home.

The redesign collapses everything into a `NavigationSplitView` with a
sidebar (5 categories) and a detail pane per category. Each category
becomes a dedicated `View` so the existing `SettingsView` shrinks to a
shell that routes selection → detail.

## What Changes

1. **Top-level `SettingsView` rewrite** — `NavigationSplitView` with a
   left sidebar (5 selectable rows) and a right detail pane. The
   sidebar entries:
   - **TTS & Audio** — TTS toggle, ducking mode, signal-only mode,
     ElevenLabs key + global voice (consolidated from
     `ElevenLabsSettingsView`), and the `ProjectVoicesView` editor
     from `notifications-overhaul`.
   - **Notifications** — banner enabled toggle, notifications-overhaul
     sort-mode default, group-by default, replay autoplay toggle.
   - **Agents** — agents.toml editor: list current peers (name,
     endpoint, machine tag), add new row, edit, delete. The seeded
     `dashboardEndpoint` from the interim `nx-4ohfs` workaround stays
     visible as a read-only "interim seed" row until the operator
     either confirms it as an agents.toml entry or removes it.
   - **Dashboard** — refresh interval, default view, theme (system /
     dark / light if it doesn't auto-follow), accent color, font
     scale (.normal | .compact).
   - **Diagnostics** — read-only pane: last health snapshot, last
     watcher tick (with traffic-light staleness), socket spine
     listening state, DB ok flag, agent build SHA, dashboard version.
     One-click "Copy diagnostics to clipboard" generates a
     plain-text report for bug reports.

2. **Sidebar persistence** — selected category persists via
   `@AppStorage("settings.sidebar.selection")`. Default category on
   first launch is `tts` (highest signal for new users).

3. **Per-category detail views (new files)** — five new dedicated
   views under `apps/swift/nexus-mac/Sources/Dashboard/Settings/`:
   `SettingsTtsView.swift`, `SettingsNotificationsView.swift`,
   `SettingsAgentsView.swift`, `SettingsDashboardView.swift`,
   `SettingsDiagnosticsView.swift`. Each owns its `@StateObject`
   view-model.

4. **`ElevenLabsSettingsView.swift` deprecated and absorbed** —
   `SettingsTtsView` mounts the existing key paste + voice id fields
   inline. The old view file deletes; any external entry points
   (currently zero) are removed.

5. **agents.toml editor** — `AgentsConfigStore` (new helper in
   NexusShared) reads/writes the TOML file using a tiny hand-rolled
   serializer (matches the existing hand-parse in `AgentRegistry`).
   Schema: array-of-tables `[[agents]]` with `name`, `endpoint`,
   `machine` keys. The editor renders the existing list, inline
   editing, add/remove. Save calls `AgentsConfigStore.write()` which
   triggers an in-app `NotificationCenter` post so
   `NexusAggregateClient` re-bootstraps without an app relaunch.

6. **Diagnostics pane content** — calls a single
   `NexusClient.diagnostics()` aggregation that reuses the existing
   `/health?detail=true` endpoint for liveness + watcher tick. The
   pane formats the JSON into a labelled key/value list with
   traffic-light dots beside each liveness field.

7. **Copy diagnostics to clipboard** — Button captures the latest
   /health JSON + dashboard version (from CFBundleShortVersionString)
   + build SHA (read from `Bundle.main.infoDictionary["GitSha"]` if
   present) + agents.toml entry count, formats as plain-text under
   a `nexus diagnostics — <date>` header, copies via
   `NSPasteboard.general.setString(_:forType: .string)`.

8. **Existing `SettingsViewModel` split** — the current
   `SettingsViewModel` carries fields for all four flat sections.
   Refactor: keep a thin `SettingsRouterViewModel` that holds
   the sidebar selection, and lift each category's state into the
   per-category view-model. Existing persistence keys preserved
   verbatim — no settings reset for existing users.

## Context

- depends on: 
- touches: `apps/swift/nexus-mac/Sources/Dashboard/SettingsView.swift`, `apps/swift/nexus-mac/Sources/Dashboard/Settings/SettingsTtsView.swift`, `apps/swift/nexus-mac/Sources/Dashboard/Settings/SettingsNotificationsView.swift`, `apps/swift/nexus-mac/Sources/Dashboard/Settings/SettingsAgentsView.swift`, `apps/swift/nexus-mac/Sources/Dashboard/Settings/SettingsDashboardView.swift`, `apps/swift/nexus-mac/Sources/Dashboard/Settings/SettingsDiagnosticsView.swift`, `apps/swift/nexus-mac/Sources/ElevenLabsSettingsView.swift`, `apps/swift/NexusShared/Config/AgentsConfigStore.swift`, `apps/swift/NexusShared/Config/AgentsConfigStore.test.swift`, `apps/swift/NexusShared/Networking/AgentRegistry.swift`, `apps/swift/NexusShared/Networking/NexusAggregateClient.swift`, `apps/swift/nexus-mac/Sources/Dashboard/Settings/SettingsTtsViewTests.swift`, `apps/swift/nexus-mac/Sources/Dashboard/Settings/SettingsAgentsViewTests.swift`, `apps/swift/nexus-mac/Sources/Dashboard/Settings/SettingsDiagnosticsViewTests.swift`

Sibling-spec coordination:

- `notifications-overhaul` defines `ProjectVoicesView` — this spec
  mounts it inside `SettingsTtsView`. Append-only composition; no
  conflict. If the two specs land in different waves, the
  notifications-overhaul one MUST land first because it owns the
  view file; if they swap, `SettingsTtsView` will reference a
  missing type. Capture as a soft dependency in `depends on:` if
  the order isn't already enforced by wave-plan-build via the
  shared touched files.
- All six prior specs touch `NexusClient.swift` /
  `NexusAggregateClient.swift`. This spec touches
  `NexusAggregateClient.swift` only to add a re-bootstrap method
  the agents.toml editor calls after a write. Appended method,
  same conflict-serialization story.

## Risk

- **agents.toml malformed write.** Operator can paste garbage into
  a row. Mitigation: validate per-row before serializing (endpoint
  must be a URL, machine must be alphanumeric+hyphen, name must
  be non-empty). On parse failure of an existing file, render the
  raw text in a fallback "edit raw TOML" pane so the operator can
  fix it instead of losing data.
- **In-app re-bootstrap timing.** `NexusAggregateClient` ticks every
  5s; mid-tick rebootstrap can lose an in-flight response.
  Mitigation: cancel-current-tick + restart pattern — same shape
  used by the projects-tab-accordion-deeplink deep-link cancel.
- **Diagnostics pane disclosing sensitive info.** The clipboard
  payload includes machine hostname and agent endpoint. Mitigation:
  before copy, prompt with a confirmation showing the exact payload
  so the operator can review before paste-into-public.
- **Settings view-model split regression.** The existing
  `SettingsViewModel` has cross-section dependencies (e.g., test
  agent URL needs both URL + status fields). Mitigation: keep a
  shared `AgentConnectionService` that both `SettingsAgentsView`
  and `SettingsDiagnosticsView` consume; don't fragment the
  network-test logic across files.
- **Persistence key drift.** Splitting the view-model is a refactor
  hotspot for losing UserDefaults keys. Mitigation: lift each key
  one-by-one with `@AppStorage` (which uses the same UserDefaults
  store), keep the existing key literals verbatim, add a one-time
  migration check on launch confirming all expected keys are still
  readable.
