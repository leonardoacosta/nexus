# Change: Add project badges and scratchpad to Projects screen

## Why

The Projects screen currently shows a table of session counts (total, active, idle, stale, error)
but lacks at-a-glance visual indicators and has no way to attach user notes to projects. Badges
provide instant project health recognition (colored status dots, last activity), and a scratchpad
gives users a place to pin per-project context without leaving the TUI.

## What Changes

- Add visual badges to each project row: activity status dot (green/yellow/dim), last activity
  timestamp derived from the most recent `last_heartbeat` across sessions in that project
- Add a per-project scratchpad overlay, toggled with `e` key, that lets users write and persist
  freeform notes
- Persist scratchpad notes in `~/.config/nexus/project-notes.toml` keyed by project name
- Extend `ProjectSummary` struct with `last_activity` and `activity_status` fields
- Add `ProjectNotes` model to `nexus-core` for TOML serialization/deserialization
- Add `InputMode::ScratchpadEdit` variant for the text editor overlay

## Impact

- Affected specs: `project-badges` (new capability)
- Affected code:
  - `crates/nexus-core/src/session.rs` (no changes, data source only)
  - `crates/nexus-tui/src/app.rs` (ProjectSummary extension, new InputMode, scratchpad state)
  - `crates/nexus-tui/src/screens/projects.rs` (badge rendering, scratchpad overlay)
  - `crates/nexus-tui/src/main.rs` (key handler for `e` key, scratchpad input mode)
  - `crates/nexus-core/src/config.rs` or new `crates/nexus-core/src/notes.rs` (TOML persistence)
