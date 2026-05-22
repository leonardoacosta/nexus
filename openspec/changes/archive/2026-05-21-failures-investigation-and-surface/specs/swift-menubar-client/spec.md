# swift-menubar-client Delta

## ADDED Requirements

### Requirement: failures-filter-chips
The Failures tab MUST render a summary strip above the `top_errors[]` list showing the keys of `by_tool` and `by_project` as tap-to-filter chips. Tapping a chip MUST filter the visible `top_errors[]` client-side (no re-fetch) to rows matching the chip. Multi-select MUST be additive within a category (selecting `Read` and `Bash` shows both tool families) and AND across categories (selecting `Read` AND `nx` shows only Read failures in nx). A clear-filters affordance MUST be present when at least one chip is active.

#### Scenario: single-tool filter
- **Given** Failures tab shows 12 rows across tools `Read` (8), `Bash` (3), `Write` (1)
- **When** the user taps the `Read` chip
- **Then** the list shrinks to the 8 Read rows; other chips remain visible but greyed

#### Scenario: tool + project AND
- **Given** the user has selected `Read` and project chip `nx`
- **When** rendering
- **Then** only rows where tool == "Read" AND project == "nx" are shown

#### Scenario: clear filters
- **Given** at least one chip is active
- **When** the user taps the clear-filters affordance
- **Then** all chips deselect and the full `top_errors[]` is re-rendered

### Requirement: failures-empty-state-disambiguation
The Failures tab MUST distinguish between "no failures globally" and "no failures match current filter". When `total == 0`, the existing empty-state placeholder ("No failures") MUST render unchanged. When `total > 0` but the active filter yields zero visible rows, the placeholder MUST instead read "No failures match this filter" with a clear-filters action.

#### Scenario: empty globally
- **Given** the response has `total: 0`
- **When** the tab renders
- **Then** the empty-state shows "No failures"

#### Scenario: empty by filter
- **Given** the response has `total: 12` and an active filter that no row matches
- **When** the tab renders
- **Then** the placeholder shows "No failures match this filter" with a "Clear filters" button

### Requirement: failures-trend-indicator
The Failures tab header MUST render a trend indicator next to the failure-count chip when `trend.direction != "flat"`. The indicator MUST show `↑Y%` in red when direction is `"up"`, `↓Y%` in green when `"down"`, where Y is `round(|current-previous|/max(previous,1) * 100)`. `direction == "flat"` MUST hide the indicator entirely (no zero-percent visual noise).

#### Scenario: rising trend
- **Given** `trend: { current: 50, previous: 10, direction: "up" }`
- **When** the tab renders
- **Then** the header shows `↑400%` in red next to the count chip

#### Scenario: flat trend hides indicator
- **Given** `trend.direction: "flat"`
- **When** the tab renders
- **Then** no trend indicator is rendered (the header retains only the count chip)
