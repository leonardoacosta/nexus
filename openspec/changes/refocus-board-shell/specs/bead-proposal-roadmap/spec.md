# bead-proposal-roadmap Delta

## ADDED Requirements

### Requirement: All-projects roadmap aggregation

`GET /roadmap?project=all` SHALL fan out the existing per-project roadmap computation across
every registered, non-hidden project concurrently and return the merged capability list, with
each capability tagged with an additional `project` field carrying the source project code.
A project whose computation fails (bd unavailable, missing `.beads/`, thrown aggregator) SHALL
be excluded from the merge and logged; the route SHALL still return HTTP 200 with the surviving
projects' capabilities. The single-project form (`?project=<code>`) SHALL be byte-compatible
with its pre-change response shape.

#### Scenario: Merged all-projects response

- **WHEN** `GET /roadmap?project=all` is requested with three registered non-hidden projects of
  which two have `.beads/` directories
- **THEN** the response is HTTP 200 with `capabilities` containing entries from both resolvable
  projects, each entry carrying `project` set to its source code, and no entry for the third

#### Scenario: One project's bd fails mid-fan-out

- **WHEN** `computeRoadmap` throws for exactly one project during an `all` fan-out
- **THEN** the response is HTTP 200 containing the other projects' capabilities, the failure is
  logged at warn level, and no 5xx is returned

#### Scenario: Hidden projects excluded

- **WHEN** a registered project is marked `hidden: true` and `GET /roadmap?project=all` runs
- **THEN** that project contributes no capabilities to the merged response

#### Scenario: Single-project shape unchanged

- **WHEN** `GET /roadmap?project=nx` is requested after this change
- **THEN** the response shape matches the pre-change contract (no `project` field required on
  entries, existing decoders parse unchanged)

### Requirement: All-projects unlinked-bead aggregation

`GET /beads/unlinked?project=all` SHALL apply the same concurrent fan-out, project tagging,
per-project degradation, and single-project back-compat contract as the roadmap aggregation,
returning the merged `unlinked` list with each bead tagged with its source `project` code.

#### Scenario: Merged unlinked beads with project tags

- **WHEN** `GET /beads/unlinked?project=all` is requested and two projects have open unlinked
  beads
- **THEN** the response merges both projects' beads, each carrying `project`, and a project
  whose `bd list` fails contributes nothing while the route returns HTTP 200

### Requirement: Bead descriptions on rollup and unlinked surfaces

`BeadRef` and `UnlinkedBead` wire types SHALL carry an optional `description` field populated
from the `description` already present in `bd list --json` output, so board rows can expand to
a description without a second fetch. Absence of a description (older payloads, beads without
one) SHALL decode cleanly on all clients.

#### Scenario: Description present on task bead

- **WHEN** a rollup is computed for a proposal whose task bead has a non-empty bd description
- **THEN** the corresponding `BeadRef` in the response carries that text in `description`

#### Scenario: Missing description tolerated

- **WHEN** a bead has no description in bd
- **THEN** the field is omitted (not null-stringed) and existing Swift decoders parse the
  payload without error
