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

#### Scenario: Proposal expands to tasks and descriptions

- **WHEN** the user expands a proposal row with linked task beads
- **THEN** task rows render with closed/open state, and expanding a task shows its bd
  description inline

#### Scenario: Orphans visible in All mode

- **WHEN** `All` is selected and two projects have unlinked open beads
- **THEN** those beads appear as top-level rows tagged with their project code, interleaved
  with proposal rows, never hidden behind a separate tab

### Requirement: Detail rail

Selecting any row SHALL populate a right-hand detail rail with: bead ids and badges, title,
owning spec slug and capability, description, task list with states, dependencies/blockers,
recent TTS notifications scoped to the row's project, and actions (attach to the project's live
session where one exists; approve/reject for proposals in an approval-gate state; `bd show`
affordance). Spec content rendering SHALL reuse the existing spec-content fetch
(`GET /specs/:project/:name/:file`).

#### Scenario: Proposal detail shows rollup and actions

- **WHEN** a proposal row is selected
- **THEN** the detail rail shows its task rollup, dependency list, recent project-scoped TTS
  history, and — when the proposal's approval gate is open — approve/reject actions

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

