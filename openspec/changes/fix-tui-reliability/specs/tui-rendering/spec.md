## MODIFIED Requirements

### Requirement: Cached session aggregation
The App state SHALL maintain a pre-computed sorted list of sessions and a pre-computed list of
project summaries. These caches SHALL be invalidated and recomputed only when `update_agents`
receives new data. All rendering and input-handling code SHALL read from the cached slices
rather than recomputing on each access. `AppState` SHALL additionally track
`last_data_updated: Option<Instant>` updated on every `update_agents` call, used to drive the
data freshness indicator.

#### Scenario: Cache populated on agent data update
- **WHEN** `update_agents` is called with new agent data
- **THEN** the cached session list is recomputed (cloned, sorted by project then start time)
- **AND** the cached project summaries are recomputed (aggregated by project name)
- **AND** `last_data_updated` is set to `Instant::now()`

#### Scenario: Render frame reads from cache without recomputation
- **WHEN** the dashboard screen renders a frame
- **AND** no new agent data has arrived since the last render
- **THEN** `cached_sessions()` returns a borrowed slice of the existing cached list
- **AND** no new allocations or sorting occur

#### Scenario: Multiple callers share the same cached data
- **WHEN** the status bar, palette, and dashboard all access session data within a single frame
- **THEN** all three read from the same cached `&[SessionRow]` slice
- **AND** `all_sessions()` is not called

#### Scenario: Project summaries cached identically
- **WHEN** `cached_project_summaries()` is called
- **THEN** it returns a borrowed slice of the pre-computed project summaries
- **AND** no BTreeMap aggregation occurs

## ADDED Requirements

### Requirement: Data freshness indicator
The status bar SHALL display "Updated Xs ago" showing how long ago `last_data_updated` was set.
When staleness exceeds 30 seconds, the indicator SHALL switch to yellow/dim style to signal
that displayed data may be out of date.

#### Scenario: Fresh data — normal style
- **WHEN** `last_data_updated` was set less than 30 seconds ago
- **THEN** the status bar shows "Updated Xs ago" in normal foreground style

#### Scenario: Stale data — warning style
- **WHEN** `last_data_updated` was set 30 or more seconds ago
- **THEN** the status bar shows "Updated Xs ago" in yellow/dim foreground
- **AND** session rows are rendered with a dim modifier to signal potentially stale data

#### Scenario: No data yet
- **WHEN** `last_data_updated` is `None`
- **THEN** the status bar shows "No data" in dim style

### Requirement: Terminal resize handling
The TUI event loop SHALL match `crossterm::event::Event::Resize(cols, rows)` and immediately
call `terminal.resize(Rect { width: cols, height: rows, x: 0, y: 0 })` followed by a forced
redraw. The layout SHALL recompute based on the new terminal dimensions within the same event
loop tick.

#### Scenario: Window resized wider
- **WHEN** the terminal emulator is resized to a wider width
- **THEN** the TUI redraws within one event loop tick using the new width
- **AND** no stale layout artifacts remain visible

#### Scenario: Window resized smaller
- **WHEN** the terminal emulator is resized to a smaller size
- **THEN** the TUI redraws within one event loop tick using the new dimensions
- **AND** content that no longer fits is clipped rather than panicking

### Requirement: Snapshot metadata preservation
The TUI SHALL preserve all metadata fields (`session_type`, `status`, and any future fields in
the session snapshot) when `update_agents` refreshes session state. No metadata field SHALL be
silently dropped or reset to a default value during a snapshot update cycle.

#### Scenario: Metadata survives snapshot refresh
- **WHEN** `update_agents` is called with a snapshot that includes `session_type` and `status`
- **THEN** the updated session row retains the same `session_type` and `status` values
- **AND** no field is reset to `None` or an empty string

#### Scenario: Regression test for metadata round-trip
- **WHEN** a unit test calls `update_agents` with known metadata values
- **THEN** `cached_sessions()` returns rows with identical metadata values
