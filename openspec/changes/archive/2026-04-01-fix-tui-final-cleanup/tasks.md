# Implementation Tasks

<!-- beads:epic:TBD -->

## Lint + Format Batch

- [ ] [1.1] [P-1] Run `cargo fmt -p nexus-tui` to resolve all 14 formatting hunks [owner:engineer]
- [ ] [1.2] [P-1] Fix collapsible `if` warnings in app.rs and keys.rs — collapse nested ifs into combined conditions [owner:engineer]
- [ ] [1.3] [P-1] Remove unused import `Clear` from screens/stream.rs:6 [owner:engineer]
- [ ] [1.4] [P-1] Replace useless `format!("{type_ind}")` with direct variable in screens/dashboard.rs:124 [owner:engineer]
- [ ] [1.5] [P-1] Move items after test module in screens/health.rs to before `#[cfg(test)]` block [owner:engineer]

## Dead Code Removal Batch

- [ ] [2.1] [P-1] Remove `update_projects()` method from app.rs:782 (zero call sites) [owner:engineer]
- [ ] [2.2] [P-1] Remove `status_sparkline()` function from theme.rs:80 and its re-export in app.rs [owner:engineer]
- [ ] [2.3] [P-1] Remove `selected_rules()` and `selected_has_override()` methods from notification.rs:113,122 [owner:engineer]
- [ ] [2.4] [P-1] Remove `is_default` field from `NotificationPanelRow` in notification.rs:80 and all construction sites [owner:engineer]
- [ ] [2.5] [P-1] Fix `backoff_duration()` in client.rs:209 — move to `#[cfg(test)]` if test-only, fix doc comment "5+->30s" to "5+->16s" [owner:engineer]

## Render Performance Batch

- [ ] [3.1] [P-1] Refactor `render_dashboard` in screens/dashboard.rs:49 to borrow `&[CachedSession]` slice instead of `.to_vec()` clone [owner:engineer]
- [ ] [3.2] [P-1] Refactor `render_projects` and `render_project_detail` in screens/projects.rs:45,169 to borrow `&[ProjectSummary]` slices instead of `.to_vec()` clones [owner:engineer]

## Correctness + Safety Batch

- [ ] [4.1] [P-1] Fix stale alert endpoints: resubscribe alert streams after `ReloadConfig` in main.rs — cancel old stream and create new one from updated client.agents [owner:engineer]
- [ ] [4.2] [P-1] Restructure notification panel key handler in keys.rs:572-599 to reuse existing `panel` binding from match guard instead of 4 separate `unwrap()` calls [owner:engineer]
- [ ] [4.3] [P-2] Pass actual terminal width to `push_markdown` in stream_state.rs:121 instead of hardcoded 120 — accept width parameter or read terminal dimensions [owner:engineer]
- [ ] [4.4] [P-2] Source default CWD from agent project data in keys.rs:741 — use project path from agent listing when available, fall back to `~/dev/{project}` [owner:engineer]

## Verification Batch

- [ ] [5.1] Verify `cargo fmt -p nexus-tui -- --check` exits 0 [owner:engineer]
- [ ] [5.2] Verify `cargo clippy -p nexus-tui` reports 0 warnings for nexus-tui [owner:engineer]
- [ ] [5.3] Verify `cargo test -p nexus-tui` passes with no regressions [owner:engineer]
- [ ] [5.4] Verify `cargo build -p nexus-tui` succeeds [owner:engineer]
