# Change: Implement Session Detail, Command Palette, and Start Session flow

## Why

The TUI Dashboard (spec 6) shows sessions at a glance, but users need to drill into individual
sessions for full metadata and activity history. Additionally, there is no way to quickly navigate
to sessions by name, switch screens, or start new managed sessions without leaving the dashboard.
This spec delivers the three remaining interactive TUI surfaces: Detail, Palette, and the Start
Session flow.

## What Changes

- **Rewrite** `crates/nexus-tui/src/screens/detail.rs`: full session detail view showing session
  ID, PID, project, branch, cwd, started_at, age, status, spec, current command, current agent,
  session type ([M]/[A]), tmux session name (if managed). Key-value layout with box-drawing borders.
- **Rewrite** `crates/nexus-tui/src/screens/palette.rs`: command palette overlay activated by `:`
  or `/` key. Fuzzy search (substring/prefix matching) across sessions, projects, and actions.
  Actions include: jump to session, switch screen, start session, stop session.
- **Modify** `crates/nexus-tui/src/app.rs`: add `Screen::Detail` and `Screen::Palette` transitions,
  input mode enum (Normal/PaletteInput/StartSessionInput), `n` key handler for start session flow,
  `:` and `/` handlers for palette activation, palette query state, start session wizard state
  (agent selection -> project code -> cwd -> RPC call).
- Start session flow: `n` key from dashboard -> select agent (if multiple configured) -> enter
  project code/cwd -> `StartSession` RPC -> session appears in dashboard as [M]

## Impact

- Affected specs: tui-dashboard (MODIFIED -- adds Detail screen, Palette screen, start session flow)
- Affected code: `crates/nexus-tui/src/{app.rs, screens/detail.rs, screens/palette.rs}`
- No breaking changes -- detail.rs and palette.rs are stubs being implemented for the first time;
  app.rs additions are purely additive on top of spec 6's state machine
- Phase 4, Wave 4 -- estimated ~300 LOC
- Depends on: tui-screens-and-aggregation (spec 6) -- needs app state, screen navigation, NexusClient
- Depended on by: tui-attach-and-alerts (spec 9)
