# exceptions-feed Specification

## Purpose
TBD - created by archiving change add-fleet-exceptions-feed. Update Purpose after archive.
## Requirements
### Requirement: The agent SHALL compute fleet bead exceptions from local stores without ever throwing

nexus-agent SHALL read every `~/dev/*/.beads` store via Dolt (two-query
whole-graph read, discovery via `.beads/metadata.json`) falling back to parsing
`issues.jsonl`, and compute exception classes: P0/P1 open issues, in_progress
claims older than 7 days, ready-head older than 30 days, and unarchived
openspec proposal count per repo. A missing/corrupt store SHALL be skipped and
reported as a `skipped` entry, never a thrown error.

#### Scenario: Dolt unavailable falls back to JSONL
- **GIVEN** a repo whose Dolt server is not running
- **WHEN** the fleet scan runs
- **THEN** that repo's exceptions are computed from issues.jsonl

#### Scenario: Corrupt store is skipped, not fatal
- **GIVEN** one repo with an unparseable issues.jsonl among healthy repos
- **WHEN** the fleet scan runs
- **THEN** healthy repos' exceptions are returned and the corrupt repo appears under `skipped`

### Requirement: GET /exceptions SHALL serve a cached, exceptions-only payload

The agent SHALL serve `GET /exceptions` from a stale-while-revalidate cache
(TTL 5 minutes, detached background refresh) and SHALL fail soft to an empty
exceptions payload with 200. The payload SHALL contain only exception entries
(class, repo, count, up to 3 worst offender ids) — never a full issue list. A
fleet with no exceptions SHALL yield an empty exceptions array.

#### Scenario: Clean fleet yields empty payload
- **GIVEN** no repo has any exception-class hit
- **WHEN** `GET /exceptions` is called
- **THEN** the response is 200 with an empty exceptions array

#### Scenario: Offender ids are capped
- **GIVEN** a repo with 40 stale in_progress claims
- **WHEN** the payload renders that entry
- **THEN** it carries count=40 and at most 3 offender ids

### Requirement: Surfaces SHALL be silent when clean

The macOS menubar exceptions section and the web /radar exceptions row SHALL
render only when the exceptions array is non-empty; on a clean feed neither
surface SHALL occupy any space. Neither surface SHALL offer navigation to a
browsable item list.

#### Scenario: Clean feed renders nothing
- **GIVEN** an empty exceptions array
- **WHEN** the menubar popover and /radar page render
- **THEN** no exceptions section or row appears in either

#### Scenario: Exceptions render as shape, not items
- **GIVEN** exceptions in two repos
- **WHEN** the menubar section renders
- **THEN** each line shows repo, class, count, and offender ids as text, with no scrollable list or drill-in

