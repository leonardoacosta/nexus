# spec-watcher Specification Delta

## ADDED Requirements

### Requirement: Spec watcher scans configured workspace roots

The agent's spec-watcher service SHALL scan configured workspace roots
for OpenSpec proposals on startup AND at a configured polling interval.
Default workspace root is `~/dev`; default poll interval is 60 seconds.

#### Scenario: startup scan populates /specs immediately

- **GIVEN** the agent boots with `~/dev/nx/openspec/changes/foo/` and
  `~/dev/nx/openspec/changes/bar/` present
- **WHEN** the agent finishes initialization (within 5 seconds)
- **THEN** `GET /specs` returns at least two entries with `name=foo` and
  `name=bar`
- **AND** each entry has `project=nx`

#### Scenario: poll interval picks up new specs

- **GIVEN** the spec-watcher is running with poll interval 60s
- **WHEN** the operator creates a new directory
  `~/dev/nx/openspec/changes/baz/` with at least a `proposal.md`
- **THEN** within 90 seconds, `GET /specs` returns an entry with
  `name=baz`

#### Scenario: removed spec disappears from /specs

- **GIVEN** a spec `foo` is in /specs results
- **WHEN** the operator archives it (moves to
  `~/dev/nx/openspec/changes/archive/<date>-foo/`)
- **THEN** within 90 seconds, `GET /specs` no longer returns `foo`
  (archived specs are out of scope per this spec's "Out of Scope")

### Requirement: Workspace roots are configurable via config file

The spec-watcher SHALL read its workspace roots from
`~/.config/nexus/spec-watcher.toml` (or the agent's canonical config
location). The default roots MUST include `~/dev` if no config file is
present.

#### Scenario: default roots used when config missing

- **WHEN** the config file does not exist
- **THEN** the spec-watcher scans `~/dev/*/openspec/changes/`
- **AND** the agent logs the resolved root list at startup

#### Scenario: custom roots from config

- **GIVEN** the config file contains `roots = ["~/dev", "~/work/clientX"]`
- **WHEN** the spec-watcher starts
- **THEN** it scans BOTH glob expansions

### Requirement: Each spec emission includes filesystem marker tri-state

The spec-watcher SHALL include filesystem marker booleans on each emit.
Per agent-payload-completeness (archived 2026-05-20), the spec-watcher
emit MUST include `has_proposal`, `has_design`, `has_tasks` booleans
derived from filesystem presence at scan time. This requirement
re-affirms that contract under the broader "spec-watcher actually
scans" guarantee.

#### Scenario: complete spec reports all three markers true

- **GIVEN** a spec directory with proposal.md + design.md + tasks.md
- **WHEN** the spec-watcher emits it
- **THEN** the row has `has_proposal=true`, `has_design=true`,
  `has_tasks=true`

#### Scenario: proposal-only spec reports partial tri-state

- **GIVEN** a spec directory with only proposal.md
- **WHEN** the spec-watcher emits it
- **THEN** the row has `has_proposal=true`, `has_design=false`,
  `has_tasks=false`

### Requirement: Completed task count reflects tasks.md state

The spec-watcher SHALL emit completedTasks and totalTasks fields
matching tasks.md state. For each emitted spec, the `completedTasks`
and `totalTasks` fields MUST reflect the count of `- [x]` and total
`- [ ]`/`- [x]` lines in the spec's `tasks.md`. If tasks.md is missing,
both counts are 0.

#### Scenario: completed count matches checkbox grep

- **GIVEN** a tasks.md with 5 `- [x]` lines and 3 `- [ ]` lines
- **WHEN** the spec-watcher emits the row
- **THEN** `completedTasks=5` and `totalTasks=8`

#### Scenario: empty tasks.md yields zeroes

- **GIVEN** a tasks.md with no checkbox lines (only headers/prose)
- **WHEN** the spec-watcher emits the row
- **THEN** `completedTasks=0` and `totalTasks=0`
