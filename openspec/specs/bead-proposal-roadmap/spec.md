# bead-proposal-roadmap Specification

## Purpose
TBD - created by archiving change add-bead-proposal-roadmap-surface. Update Purpose after archive.
## Requirements
### Requirement: Per-proposal bead rollup

The agent SHALL, for any OpenSpec proposal, compute a live bead rollup by parsing the
`beads:epic`, `beads:feature`, and `[beads:<id>]` markers already written into the proposal's
`tasks.md` by `spec-sync`, resolving their live state via a single batched `bd list --id <csv>
--json`, and aggregating task-level counts (total, closed, ready, blocked). The rollup SHALL be
attached to `GET /specs/:project/:name` and `GET /specs/all`.

#### Scenario: Proposal with linked beads

- **WHEN** `GET /specs/nx/ios-session-navigation` is requested for a proposal whose `tasks.md`
  carries `<!-- beads:epic:nx-ywqig -->`, `<!-- beads:feature:nx-6w2s0 -->`, and 15 `[beads:...]`
  task markers
- **THEN** the response includes a `beadRollup` with `epic.id == "nx-ywqig"`,
  `feature.id == "nx-6w2s0"`, `tasks.total == 15`, and `tasks.closed` equal to the count of
  those task beads whose live `bd` status is `closed`

#### Scenario: Task bead was deleted or renamed

- **WHEN** a `tasks.md` marker references a bead id that `bd list --id` no longer returns
- **THEN** the missing bead is omitted from the rollup and the route returns HTTP 200 (never 500),
  with `tasks.total` counting only beads `bd` actually returned

#### Scenario: bd is unavailable

- **WHEN** the `bd` CLI errors or the project has no `.beads/` directory
- **THEN** `beadRollup` is `null` and the spec payload is otherwise unchanged

### Requirement: Ready and blocked derivation match the fleet

The rollup's `ready` count SHALL be the intersection of the proposal's task bead ids with
`bd ready --json` membership, and `blocked` SHALL count task beads whose status is `blocked` or
which have an unclosed `blocks` dependency, so "ready" and "blocked" carry the same meaning as
elsewhere in the beads workflow.

#### Scenario: Blocked-by-dependency task

- **WHEN** a task bead is `open` but depends on another open bead via a `blocks` edge
- **THEN** it is counted in `tasks.blocked` and excluded from `tasks.ready`

### Requirement: Unlinked open beads

The agent SHALL expose `GET /beads/unlinked?project=<code>` returning open and in-progress beads
that are not referenced by any live (non-archived) proposal's `tasks.md`, so unplanned work is
visible alongside proposal-linked work.

#### Scenario: Ad-hoc bead with no proposal

- **WHEN** an open bead (e.g. an ad-hoc `bd create` with no `--spec-id`) is not referenced by any
  live proposal's `tasks.md`
- **THEN** it appears in the `/beads/unlinked` response

#### Scenario: Bead whose proposal was archived

- **WHEN** a bead's only referencing proposal has been archived
- **THEN** the bead, if still open, appears as unlinked (archived proposals are not scanned for
  linkage)

### Requirement: Capability roadmap aggregation

The agent SHALL expose `GET /roadmap?project=<code>` that enumerates `[CAPABILITY]` epics, maps
each child feature bead to its proposal via the feature bead's `spec_id`, reuses the per-proposal
bead rollup, and reports per-proposal and per-capability task progress.

#### Scenario: Capability with multiple proposals

- **WHEN** a `[CAPABILITY]` epic has two child feature beads whose `spec_id`s resolve to two
  proposals
- **THEN** the roadmap response lists the capability with both proposals, each carrying its
  `beadRollup`, and a `progress` equal to summed closed tasks over summed total tasks across both

#### Scenario: Feature bead points at an archived proposal

- **WHEN** a feature bead's `spec_id` resolves to an archived proposal
- **THEN** the proposal is still listed under its capability (classified, not dropped), with the
  rollup computed from the archived `tasks.md`

### Requirement: Dashboard surfaces the rollup, unlinked beads, and roadmap

The macOS dashboard SHALL render, on the Specs tab, a per-proposal progress bar and ready-count
chip, an "Unlinked open beads" section, and a bead list in the proposal detail view; and SHALL
provide a Roadmap tab rendering capabilities, their proposals, and progress. The statusline SHALL
show a specs line and a roadmap line behind the existing stale-while-revalidate cache.

#### Scenario: Specs tab renders a proposal's progress

- **WHEN** the Specs tab loads a proposal whose agent payload carries a `beadRollup` of 14 closed
  of 15 tasks with 1 ready
- **THEN** the row shows a progress bar at 14/15 and a "1 ready" chip, and tapping the epic id
  navigates to that bead

#### Scenario: Roadmap tab renders capabilities

- **WHEN** the Roadmap tab loads and the `/roadmap` payload lists a capability with proposals
- **THEN** the capability appears with an aggregate progress bar and expands to show each proposal
  with its own progress

#### Scenario: Codable decode of the agent payload

- **WHEN** the NexusShared models decode a fixture `beadRollup` / `RoadmapCapability` payload
- **THEN** decoding succeeds with non-optional rollup count fields populated

