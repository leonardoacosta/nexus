# Spec: TUI Final Cleanup

## MODIFIED Requirements

### Requirement: Alert stream subscription lifecycle
Alert streams SHALL be resubscribed when the agent configuration changes at runtime, ensuring newly-added agents receive alert subscriptions without requiring a TUI restart.

#### Scenario: New agent added via config reload gets alert subscription
**Given** the TUI is running with agents [A, B]
**When** the user adds agent C to `agents.toml` and config reload fires
**Then** agent C receives an alert stream subscription alongside A and B

#### Scenario: Removed agent stops receiving alert subscription
**Given** the TUI is running with agents [A, B, C]
**When** the user removes agent C from `agents.toml` and config reload fires
**Then** agent C's alert stream is dropped and no longer polled

### Requirement: No dead code in TUI crate
All `#[allow(dead_code)]` annotations SHALL be resolved: dead items removed, test-only items moved behind `#[cfg(test)]`, and doc comments corrected to match implementation.

#### Scenario: cargo clippy reports no dead_code warnings
**Given** the TUI crate source after cleanup
**When** `cargo clippy -p nexus-tui` is run
**Then** zero `dead_code` or `unused` warnings are emitted for the items listed in the proposal

### Requirement: cargo fmt clean
`cargo fmt -p nexus-tui -- --check` SHALL exit 0 with no diff output.

#### Scenario: Format check passes
**Given** the TUI crate source after formatting
**When** `cargo fmt -p nexus-tui -- --check` is run
**Then** exit code is 0 and no hunks are reported

### Requirement: cargo clippy clean
All clippy warnings in nexus-tui SHALL be resolved: collapsible ifs, unused imports, useless format!, items after test module.

#### Scenario: Clippy reports zero warnings for nexus-tui
**Given** the TUI crate source after fixes
**When** `cargo clippy -p nexus-tui` is run
**Then** zero warnings are emitted for the nexus-tui crate

### Requirement: Render functions borrow instead of clone
Render functions SHALL operate on borrowed slices rather than cloning cached data each frame.

#### Scenario: Dashboard render does not clone sessions
**Given** `render_dashboard` is called with `&App`
**When** it accesses session data
**Then** it borrows `&[CachedSession]` without calling `.to_vec()`

#### Scenario: Projects render does not clone summaries
**Given** `render_projects` or `render_project_detail` is called with `&App`
**When** it accesses project summary data
**Then** it borrows `&[ProjectSummary]` without calling `.to_vec()`

### Requirement: Notification panel key handlers are unwrap-free
The notification panel key handler SHALL NOT call `.as_mut().unwrap()` on `app.notification_panel`. It SHALL reuse the existing binding that the match guard already validated as `Some`.

#### Scenario: Notification panel key handler with no unwrap
**Given** the notification panel is open (match guard `Some(panel)`)
**When** any notification key (`v`, `a`, `s`, `d`) is pressed
**Then** the handler uses the existing `panel` binding without calling `unwrap()`

### Requirement: Markdown width from terminal
`push_markdown` SHALL receive the actual terminal width rather than a hardcoded 120.

#### Scenario: Markdown renders at terminal width
**Given** a terminal with width 200 columns
**When** markdown content is rendered in the stream view
**Then** `push_markdown` is called with width 200, not 120

### Requirement: CWD sourced from agent data
The default CWD for new sessions SHALL come from the agent's project listing data when available, falling back to `~/dev/{project}` only when no path is known.

#### Scenario: CWD uses agent project path when available
**Given** the agent reports project "nx" with path "/home/user/dev/nx"
**When** the user starts a new session for project "nx"
**Then** the CWD defaults to "/home/user/dev/nx"

#### Scenario: CWD falls back when agent data unavailable
**Given** the agent has no path information for project "nx"
**When** the user starts a new session for project "nx"
**Then** the CWD defaults to "~/dev/nx"
