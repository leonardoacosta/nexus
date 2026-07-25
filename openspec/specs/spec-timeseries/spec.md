# spec-timeseries Specification

## Purpose
TBD - created by archiving change add-sqlite-analytics. Update Purpose after archive.
## Requirements
### Requirement: The system MUST record spec task completion snapshots over time

The spec watcher MUST insert a timestamped snapshot into the Postgres `spec_snapshots` table
(Drizzle schema in `packages/db`, migration-based only — never `db:push`) for each spec on every
poll or watch-triggered refresh where task counts have changed, enabling delivery velocity
analysis. Rows MUST be pruned by the agent's retention job at 90 days (env-overridable).

#### Scenario: Task progress recorded

Given spec "oo/add-user-auth" was at 5/12 tasks last snapshot
When the current poll finds 8/12 tasks
Then a new spec_snapshots row is inserted with completed=8, total=12, and current timestamp

#### Scenario: No change skips insert

Given spec "oo/add-user-auth" is still at 8/12 tasks
When the current poll finds the same count
Then no new snapshot row is inserted (avoids bloat)

#### Scenario: Retention prunes old rows

Given spec_snapshots rows older than 90 days exist
When the daily retention job runs
Then those rows are deleted and the deletion count is logged

### Requirement: The system MUST record per-project status snapshots

The agent MUST insert a change-only row into `project_status_snapshots` — carrying `project`,
`proposals_unarchived` (count of directories under `openspec/changes/`, archive excluded),
`beads_ready_unlinked`, and `beads_blocked_unlinked` — whenever a spec-watcher tick or beads
recount produces totals that differ from the project's most recent row. Rows follow the same
90-day retention as `spec_snapshots`.

#### Scenario: Proposal archived produces a snapshot

- **Given** project "nexus" last snapshot recorded proposals_unarchived=2
- **When** a proposal is archived and the spec-watcher refresh counts 1
- **Then** a new row is inserted with proposals_unarchived=1 and unchanged bead counts carried forward

#### Scenario: Bead count change produces a snapshot

- **Given** project "nexus" last snapshot recorded beads_ready_unlinked=5
- **When** a beads recount finds 6 ready unlinked beads
- **Then** a new row is inserted with beads_ready_unlinked=6

#### Scenario: No change inserts nothing

- **Given** a tick recomputes totals identical to the project's latest row
- **When** the snapshot writer compares them
- **Then** no row is inserted

#### Scenario: Agent restart repopulates from disk

- **Given** the agent restarts with existing snapshot rows in Postgres
- **When** the first watcher tick completes
- **Then** counts are compared against the latest persisted row, so an unchanged project inserts nothing after restart

