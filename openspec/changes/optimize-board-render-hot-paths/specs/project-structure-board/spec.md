# project-structure-board — Delta

## MODIFIED Requirements

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

## ADDED Requirements

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
