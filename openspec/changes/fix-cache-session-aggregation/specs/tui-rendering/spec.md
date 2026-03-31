## ADDED Requirements

### Requirement: Cached session aggregation
The App state SHALL maintain a pre-computed sorted list of sessions and a pre-computed list of project summaries. These caches SHALL be invalidated and recomputed only when `update_agents` receives new data. All rendering and input-handling code SHALL read from the cached slices rather than recomputing on each access.

#### Scenario: Cache populated on agent data update
- **WHEN** `update_agents` is called with new agent data
- **THEN** the cached session list is recomputed (cloned, sorted by project then start time)
- **AND** the cached project summaries are recomputed (aggregated by project name)

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
