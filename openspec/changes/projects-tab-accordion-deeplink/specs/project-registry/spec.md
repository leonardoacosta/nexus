# project-registry Delta

## ADDED Requirements

### Requirement: git-metadata-on-projects-endpoint
The agent's `GET /projects` response MUST include a `git_metadata` object per project derived from the project's working directory. The object MUST contain `branch: string | null`, `ahead: integer`, `behind: integer`, `dirty: boolean`, and `last_commit: { author: string, ts: ISO-8601 } | null`. Non-git directories MUST receive `git_metadata: null`. The agent MUST cache the metadata per cwd with a 30-second TTL. Parallel resolution across projects is required; total response time MUST remain under 500ms p95 for hosts with up to 20 projects.

#### Scenario: clean git repo on main
- **Given** a project at `/Users/leo/dev/nx` is on branch `main`, in sync with origin, no uncommitted changes
- **When** `GET /projects` is called
- **Then** the row for `nx` contains `git_metadata: { branch: "main", ahead: 0, behind: 0, dirty: false, last_commit: { author: "leo@host", ts: "..." } }`

#### Scenario: dirty branch ahead of origin
- **Given** a project on branch `feat/foo`, 3 commits ahead of origin, untracked + modified files present
- **When** `GET /projects` is called
- **Then** the row contains `git_metadata: { branch: "feat/foo", ahead: 3, behind: 0, dirty: true, ... }`

#### Scenario: detached HEAD
- **Given** a project in detached HEAD state at commit `abc1234`
- **When** the endpoint is called
- **Then** the row contains `git_metadata: { branch: null, ahead: 0, behind: 0, dirty: false, last_commit: {...} }` — `branch` is null but the object is non-null

#### Scenario: non-git directory
- **Given** a project at `/tmp/notes` with no `.git` subdirectory
- **When** the endpoint is called
- **Then** the row contains `git_metadata: null`

#### Scenario: cache hit within 30s window
- **Given** `GET /projects` was called 5 seconds ago and the per-cwd cache is populated
- **When** the endpoint is called again
- **Then** no new `git` subprocess is spawned for the cached projects; the response uses the cached values

#### Scenario: parallel resolution on slow host
- **Given** a host with 15 large repos where each `git status` takes ~200ms
- **When** the endpoint is called cold (cache empty)
- **Then** total response time is under 500ms (parallel) rather than ~3s (sequential)

#### Scenario: git subprocess failure
- **Given** a project where `git status --porcelain=v2 --branch` exits non-zero or times out (>2s)
- **When** the endpoint is called
- **Then** the row contains `git_metadata: null` for that project; the response is not blocked or 500ed; an OTel warning span is emitted
