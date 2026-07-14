## MODIFIED Requirements

### Requirement: Detail rail

Selecting any row SHALL populate a right-hand detail rail with: bead ids and badges, title,
owning spec slug and capability, description, task list with states, dependencies/blockers,
recent TTS notifications scoped to the row's project, and actions (attach to the project's live
session where one exists; approve/reject for proposals in an approval-gate state; `bd show`
affordance). Spec content rendering SHALL reuse the existing spec-content fetch
(`GET /specs/:project/:name/:file`), routed through an in-memory, stale-while-revalidate cache
keyed by (project, slug, file): a cached entry SHALL render immediately on selection while a
background refetch runs, and the render SHALL update in place when the refetch resolves. The
detail rail SHALL show a small indicator of the selected item's cache state (cached-only,
fetch-in-flight, or fresh with a relative timestamp).

#### Scenario: Proposal detail shows rollup and actions

- **WHEN** a proposal row is selected
- **THEN** the detail rail shows its task rollup, dependency list, recent project-scoped TTS
  history, and — when the proposal's approval gate is open — approve/reject actions

#### Scenario: Re-selecting a previously-viewed proposal renders instantly from cache

- **WHEN** a user selects a proposal, navigates away, and reselects the same proposal within the
  same session
- **THEN** the detail rail renders the cached content immediately (no loading spinner), shows a
  cached-only or fresh indicator depending on whether a background refetch has completed since,
  and a background refetch runs to reconcile any changes

#### Scenario: First-ever selection shows fetch-in-flight

- **WHEN** a user selects a proposal whose spec content has never been fetched this session
- **THEN** the detail rail shows a fetch-in-flight indicator until the first fetch resolves, then
  renders the content and switches to the fresh indicator

### Requirement: Visible proposal rows are eagerly prefetched

The board SHALL kick off bounded background prefetches of the default (`proposal.md`) spec-content
tab for the first 20 visible proposal rows, in list order, whenever the visible item list changes
(filter, sort, or project selection). Orphan rows and non-default tabs SHALL NOT be eagerly
prefetched. Prefetch requests SHALL NOT block the UI and SHALL fail silently (no retry storm) on
error.

#### Scenario: Filtering the board prefetches the new visible set

- **WHEN** a user changes the project filter or sort key, changing which proposals are visible
- **THEN** the first 20 visible proposal rows' `proposal.md` content is prefetched in the
  background, without blocking the row list from rendering

#### Scenario: Orphan rows are never prefetched

- **WHEN** the visible item list includes orphan bead rows
- **THEN** no spec-content fetch is issued for those rows (they have no spec content to fetch)
