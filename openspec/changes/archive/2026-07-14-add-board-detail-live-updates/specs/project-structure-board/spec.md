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

While a proposal row is selected, the detail rail SHALL additionally hold one open SSE connection
(`GET /specs/events`) to the single agent owning that proposal's project. A `SpecTransition` event
matching the open item SHALL invalidate and trigger revalidation of its cache entry, so the
detail rail reflects server-side changes without requiring the user to reselect the row. The
connection SHALL close when the selection changes or clears, and SHALL reconnect with
exponential backoff (triggering one immediate revalidation on reconnect) if it drops
unexpectedly. When an orphan bead row is selected, the detail rail SHALL instead observe the
owning `SessionObserver`'s `lastBeadTransition` publisher and refetch the orphan's detail when a
transition arrives for its project.

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

#### Scenario: A live spec transition updates the open detail rail

- **WHEN** a proposal is open in the detail rail and a `SpecTransition` event for that same
  project/slug arrives over the open SSE connection
- **THEN** the cache entry is invalidated and revalidated, and the detail rail's rendered content
  updates in place without the user reselecting the row

#### Scenario: Deselecting closes the SSE connection

- **WHEN** the user deselects the open proposal or selects a different row
- **THEN** the SSE connection opened for the previous selection is closed before any new
  connection (for a newly-selected proposal) opens

#### Scenario: Open orphan refreshes on a project BeadTransition

- **WHEN** an orphan bead row is selected and `SessionObserver.lastBeadTransition` publishes a
  new value for the orphan's project
- **THEN** the detail rail refetches and re-renders the selected orphan's detail
