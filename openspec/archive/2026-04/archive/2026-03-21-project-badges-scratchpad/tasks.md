## 1. Core Data Model

- [ ] 1.1 Add `last_activity: Option<DateTime<Utc>>` and `activity_status: ActivityStatus` fields to `ProjectSummary` in `crates/nexus-tui/src/app.rs`
- [ ] 1.2 Create `ActivityStatus` enum (`Active`, `Idle`, `Stale`, `Errored`, `None`) in `crates/nexus-tui/src/app.rs`
- [ ] 1.3 Update `App::project_summaries()` to compute `last_activity` (max `last_heartbeat` across sessions) and `activity_status` (priority: Errored > Active > Idle > Stale > None)

## 2. Notes Persistence

- [ ] 2.1 Create `ProjectNotes` struct in `crates/nexus-core/src/notes.rs` with `load()` and `save()` methods using `~/.config/nexus/project-notes.toml`
- [ ] 2.2 Add `pub mod notes;` to `crates/nexus-core/src/lib.rs`
- [ ] 2.3 Implement atomic write (write to `.tmp` file, then `fs::rename`)
- [ ] 2.4 Handle missing/malformed file gracefully in `load()` (return empty map, log warning)

## 3. TUI State for Scratchpad

- [ ] 3.1 Add `InputMode::ScratchpadEdit` variant to `InputMode` enum in `app.rs`
- [ ] 3.2 Add `scratchpad_text: String` and `project_notes: ProjectNotes` fields to `App` struct
- [ ] 3.3 Add `scratchpad_project: Option<String>` to track which project is being edited
- [ ] 3.4 Load `ProjectNotes` in `App::new()` on startup
- [ ] 3.5 Add `open_scratchpad(&mut self, project: &str)` and `close_scratchpad(&mut self)` methods

## 4. Projects Screen Rendering

- [ ] 4.1 Add activity status dot column to the project table (colored dot before project name) in `render_project_table()`
- [ ] 4.2 Add "LAST ACTIVITY" column to table header and rows, showing `format_age(last_activity)`
- [ ] 4.3 Add `[N]` indicator to project rows that have scratchpad notes
- [ ] 4.4 Update column widths to accommodate new badge and activity columns

## 5. Scratchpad Overlay

- [ ] 5.1 Create `render_scratchpad()` function in `crates/nexus-tui/src/screens/projects.rs` that renders a bordered text area overlay
- [ ] 5.2 Display project name in the overlay border title
- [ ] 5.3 Render the scratchpad text with cursor position indicator

## 6. Key Handling

- [ ] 6.1 Add `e` key handler on Projects screen to open scratchpad for selected project
- [ ] 6.2 Add `ScratchpadEdit` input mode handling: `Char`, `Enter` (newline), `Backspace`, `Esc` (save and close)
- [ ] 6.3 On `Esc` from scratchpad: save notes via `ProjectNotes::save()`, update `app.project_notes`, close overlay

## 7. Render Loop Integration

- [ ] 7.1 Add scratchpad overlay rendering in `run_loop` match arm for `Screen::Projects` when `InputMode::ScratchpadEdit`

## 8. Testing

- [ ] 8.1 Test `ActivityStatus` computation: mixed statuses, all idle, errored priority, no sessions
- [ ] 8.2 Test `ProjectNotes` load/save round-trip, missing file, malformed file
- [ ] 8.3 Test `last_activity` derivation from session heartbeats
