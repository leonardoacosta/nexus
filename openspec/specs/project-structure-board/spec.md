# project-structure-board Specification

## Purpose
TBD - created by archiving change refocus-board-shell. Update Purpose after archive.
## Requirements
### Requirement: Board is the primary window

The nexus-mac dashboard's primary window SHALL be the project-structure board: a project rail,
a hierarchical work list, and a detail rail, per `docs/diagrams/nx-refocus-board.html` § 01.
The rail SHALL be the sole project selector, listing `All` first followed by registered
projects with live open-work counts; no other project-selection control SHALL exist in the
window chrome. The titlebar SHALL show a single homelab presence dot (reachable/stale states)
and the notification bell; it SHALL NOT enumerate other machines.

#### Scenario: Default launch lands on the board

- **WHEN** nexus-mac launches after this change
- **THEN** the board renders as the default view, with the rail showing `All` plus registered
  projects and their open counts

#### Scenario: Rail selection drives the board

- **WHEN** the user selects a project in the rail
- **THEN** the work list re-renders scoped to that project, and selecting `All` renders the
  merged list with a project tag on every row

### Requirement: Proposals and orphan beads are the top-level rows

The board's work list SHALL render OpenSpec proposals as first-class expandable rows (bead id,
`PROPOSAL` badge, title, capability tag, task-progress bar, status, priority) sourced from
`GET /roadmap`, flattened client-side with the capability rendered as a muted tag. Orphan beads
from `GET /beads/unlinked` SHALL render at the same top level badged `ORPHAN` (or their bd
issue type for bugs). Expanding a proposal SHALL reveal its task beads with status glyphs;
expanding a task or orphan SHALL reveal its description from the wire payload without issuing
an additional request.

Orphan beads whose project is not a registered project (the synthetic `Unregistered` rail
bucket) SHALL NOT render in the `All` work list; they SHALL render as top-level rows only when
the `Unregistered` rail row is selected. Orphan beads belonging to registered projects are
unaffected by this scoping.

#### Scenario: Proposal expands to tasks and descriptions

- **WHEN** the user expands a proposal row with linked task beads
- **THEN** task rows render with closed/open state, and expanding a task shows its bd
  description inline

#### Scenario: Orphans visible in All mode

- **WHEN** `All` is selected and two registered projects have unlinked open beads
- **THEN** those beads appear as top-level rows tagged with their project code, interleaved
  with proposal rows, never hidden behind a separate tab

#### Scenario: Unregistered orphans hidden from All

- **WHEN** `All` is selected and unlinked beads exist whose project code is not in the
  registry (phantom UUID codes)
- **THEN** those beads do not appear in the work list, and selecting the `Unregistered` rail
  row renders them as top-level rows

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

### Requirement: Navigation collapses to board plus settings

The dashboard SHALL remove the sidebar sections Roadmap, Specs, Projects, Failures, Health,
Notifications, Credentials, Integrations, Sources, and PTY. `DashboardSection` SHALL reduce to
`board` and `settings`. Persisted section defaults (`nx.dashboard.defaultView`) referencing removed
sections SHALL migrate to `board` on first launch. Deep-link coordinators SHALL route legacy
section targets to the board (project-scoped) or settings as appropriate. No source file may
retain references to deleted view types.

#### Scenario: Stale persisted default migrates

- **WHEN** `nx.dashboard.defaultView` holds a removed section value (e.g. `failures`) at launch
- **THEN** the app lands on the board without error and rewrites the stored default to `board`

#### Scenario: Legacy deep-link routes to the board

- **WHEN** a coordinator deep-link targets the removed Projects section for project `nx`
- **THEN** the board opens scoped to `nx` instead of a dead destination

### Requirement: Decide deck absorbed into proposal actions

Approve/reject SHALL be available on proposal rows and the detail rail, invoking the existing
`POST /specs/:project/:name/approve|reject` endpoints with unchanged semantics. The standalone
Decide deck views SHALL be removed.

#### Scenario: Approve from the detail rail

- **WHEN** the user approves a gated proposal from the detail rail
- **THEN** the same approval endpoint the Decide deck used is called, the row's status updates
  on the next refresh, and no Decide deck window exists anywhere in the app

### Requirement: Ambient layer — drawer, badges, attach sheet

Notifications SHALL surface as a slide-over drawer (bell / ⌘H) inheriting the existing
history list, per-row replay, meeting-mode and drop-TTS controls, plus failure entries
(`FAIL`-tagged) per design § 05. Failures SHALL additionally badge the affected board row.
Health SHALL surface as the titlebar homelab dot with an on-demand process-table popover
(re-using the existing process table component). The PTY viewer SHALL be summoned as an attach
sheet from session affordances (rail footer, detail rail) with its Stream/Full mode split and
writer-claim behavior unchanged, per design § 06; it SHALL NOT be a sidebar destination.

#### Scenario: Failure reaches the user without a failures tab

- **WHEN** a deploy failure event arrives for project `nx`
- **THEN** a `FAIL` entry appears in the drawer and the affected `nx` row (or rail entry)
  carries a failure badge, with no Failures section in the sidebar

#### Scenario: Attach summons a sheet

- **WHEN** the user triggers attach on a live session
- **THEN** the PTY surface presents as a sheet over the dimmed board in Stream mode, Full mode
  still performs the writer claim, and Esc detaches leaving board state untouched

### Requirement: Settings pane hosts operational surfaces

Credentials, Integrations, Sources, Voices, and General SHALL re-home as tabs of one Settings
window (⌘,), reusing the existing view bodies rather than rewriting them, per design § 07. A
degraded integration SHALL surface as an amber indicator on the Integrations tab and a drawer
entry, without requiring a visit to Settings.

#### Scenario: Credentials reachable only via Settings

- **WHEN** the user opens Settings
- **THEN** the Credentials tab renders the existing credentials management surface (usage bar,
  key states), and no Credentials section exists in the main sidebar

#### Scenario: Degraded integration still reaches the user

- **WHEN** an integration health check degrades while Settings is closed
- **THEN** the drawer receives an entry and the Settings affordance shows an amber indicator

### Requirement: Board-to-iOS-nav adoption SHALL be assessed via a documented spike

A design note SHALL be produced assessing how the project-structure board (rail selector w/
All, proposal rows, orphan beads, detail rail) maps onto nexus-ios Scenes navigation, ending in
an explicit go/no-go recommendation, before any iOS board implementation work is scheduled.
`NexusShared` already carries the all-variant client methods and optional project/description
decode this spike needs, so the spike is UI-shape assessment only — no new client wiring.

#### Scenario: Spike deliverable exists with an explicit go/no-go call

- **GIVEN** the spike is complete
- **WHEN** its output document is reviewed
- **THEN** it contains a UI-shape mapping of the board's rail selector / proposal rows / orphan
  beads / detail rail onto nexus-ios Scenes navigation primitives
- **AND** it ends with an explicit go or no-go recommendation, not an open-ended discussion

### Requirement: Visible-list derivation is memoized

The board's visible work list SHALL be derived (filter + sort over the loaded item set)
exactly once per input change — a load completing, a status-filter toggle, an orphans-only
toggle, a sort-key change, or a rail selection change — and the derived list SHALL be reused
by every consumer in the render pass (row list, empty-state check, visible-item statistics,
prefetch trigger) without re-deriving. Row animation SHALL NOT require whole-array equality
comparison per row; animation SHALL be keyed at the list level or on scalar row identity.

#### Scenario: Filter toggle derives once

- **WHEN** the user toggles a status filter chip with thousands of items loaded
- **THEN** the visible list is recomputed once, the row list and its statistics both reflect
  the same derived list, and the list re-renders without per-consumer re-filtering

#### Scenario: Scrolling does not re-derive

- **WHEN** the user scrolls the work list with no filter, sort, selection, or data change
- **THEN** no filter+sort derivation of the full item set occurs during scrolling

