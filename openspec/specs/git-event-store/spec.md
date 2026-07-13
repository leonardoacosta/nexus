# git-event-store Specification

## Purpose
TBD - created by archiving change add-sqlite-consolidation. Update Purpose after archive.
## Requirements
### Requirement: The system MUST persist git events to SQLite

The git observer MUST write branch switch, new commit, and detached head transitions to the
Postgres `git_events` table (Drizzle schema in `packages/db`, migration-based only — never `db:push`)
with timestamp, project, event type, and ref details, replacing fire-and-forget
tracing logs. Rows MUST be pruned by the agent's retention job at 90 days (env-overridable).
The first observation of a project after agent start establishes a baseline and MUST NOT emit
events.

#### Scenario: Branch switch persisted

Given project "oo" switches from branch "main" to "feat/auth"
When the next observer poll runs
Then a git_events row is inserted with event_type=branch_switch, from_ref=main, to_ref=feat/auth

#### Scenario: New commit detected

Given project "oo" is on branch "main" with a previously observed HEAD sha
When the poll finds a different HEAD sha on the same branch
Then a git_events row is inserted with event_type=new_commit and the new sha

#### Scenario: Detached head recorded

Given project "oo" checks out a bare sha
When the poll observes HEAD is detached
Then a git_events row is inserted with event_type=detached_head and the sha

#### Scenario: First observation emits nothing

Given the agent has just started and has no in-memory state for project "oo"
When the first poll observes branch "main"
Then the state is recorded as baseline and no git_events row is inserted

#### Scenario: Retention prunes old events

Given git_events rows older than 90 days exist
When the daily retention job runs
Then those rows are deleted and the deletion count is logged

### Requirement: The system MUST observe git state by staggered polling

The git observer MUST poll each registered project location present on the local machine every
60 seconds, in staggered batches (reusing the spec-watcher batching shape), collecting branch
(`rev-parse --abbrev-ref HEAD`), HEAD sha, detached state, and dirty working-tree counts
(modified + untracked from `status --porcelain`). Each project observation MUST fail open — a
missing directory, non-repo, bare repo, or git timeout skips that project and logs once,
leaving other projects unaffected. Filesystem watching is explicitly not used: dirty state is
working-tree-wide and unobservable from `.git/` events alone, and poll cadence is sufficient
for orbital data.

#### Scenario: Non-repo location skipped

- **Given** a registered location that has no `.git` directory
- **When** the observer poll reaches it
- **Then** the project is skipped with a single logged warning and remaining projects are still observed

#### Scenario: Slow git command does not stall the cycle

- **Given** a project whose git invocation exceeds the per-project timeout
- **When** the poll batch runs
- **Then** that observation is abandoned fail-open and the batch continues

#### Scenario: Staggered batches bound concurrency

- **Given** 20 registered local projects
- **When** a poll cycle runs
- **Then** observations execute in small sequential batches rather than 20 concurrent git spawns

### Requirement: The system MUST serve current git state and event history over HTTP

The project status payload (`GET /projects/:id/status`) MUST include a `git` object — branch,
headSha, detached, dirty counts, ahead/behind counts vs. upstream, observedAt — from the
observer's in-memory current state, and omit it when the project has not been observed.
`ahead`/`behind` MUST default to `0`/`0` when no upstream is configured (no `# branch.ab` line
in the observer's `git status --porcelain=v2 --branch` output), rather than being omitted or
null. `GET /projects/:id/git-events?days=<n>` MUST return the persisted event history (capped
at the retention window, oldest first, 404 for unknown projects). Shapes MUST be defined as Zod
schemas in `packages/core/src/types/git-status.ts` and routes registered via the same
`tryHandle*` delegation as the status routes.

#### Scenario: Status payload includes git state

- **Given** project "nexus" was observed on branch "main" with 2 modified files
- **When** a client requests GET /projects/nexus/status
- **Then** the response includes git.branch=main, git.dirty counts, and git.observedAt

#### Scenario: Status payload includes ahead/behind when upstream is configured

- **Given** project "nexus" was observed on branch "main" which is 3 commits ahead and 1 commit
  behind its upstream
- **When** a client requests GET /projects/nexus/status
- **Then** the response includes git.ahead=3 and git.behind=1

#### Scenario: Ahead/behind default to zero with no upstream

- **Given** project "scratch" was observed on a branch with no upstream configured
- **When** a client requests GET /projects/scratch/status
- **Then** the response includes git.ahead=0 and git.behind=0 rather than omitting the fields

#### Scenario: Unobserved project omits git object

- **Given** project "ghost-repo" is registered but its location is on another machine
- **When** a client requests its status
- **Then** the response contains no git object rather than stale or empty values

#### Scenario: Event history window

- **Given** project "nexus" has git_events rows spanning 30 days
- **When** a client requests GET /projects/nexus/git-events?days=7
- **Then** only the last 7 days of events are returned, oldest first

