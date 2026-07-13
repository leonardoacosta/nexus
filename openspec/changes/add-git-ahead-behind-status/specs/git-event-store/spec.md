## MODIFIED Requirements

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
