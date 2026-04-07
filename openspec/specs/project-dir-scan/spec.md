# project-dir-scan Specification

## Purpose
TBD - created by archiving change add-project-management. Update Purpose after archive.
## Requirements
### Requirement: project-dir-scan
The nexus-agent SHALL read `NEXUS_PROJECTS_DIR` env var (default: `~/dev`) at startup and store
it in `AppState`. `GET /projects/discovered` MUST accept an optional `depth` query parameter
(integer 1–3, default 1) and SHALL recursively scan `projects_dir` up to `depth` levels. A
directory MUST be included only if it contains a project marker at its root: `.git/` directory,
`package.json`, or `Cargo.toml`. Symlinks SHALL be resolved via `fs.realpathSync` before
inclusion; if resolution fails the entry is skipped. If two directory entries resolve to the
same canonical path within a single scan cycle, only one entry SHALL appear in the response;
the dedup set MUST be initialized fresh at the start of each cache-miss scan, not per HTTP
request. The scan MUST complete within 5 seconds; entries discovered before timeout ARE returned.
Results MUST be merged with session counts from `SessionRegistry`: `activeSessions` is the count
of sessions with `status = "active"` or `last_seen` within **1 hour** (not 5 minutes);
`totalSessions` is the count of all sessions whose `cwd` starts with the project path or whose
`project` field matches the directory name, within the configured query window (default 24 h).
Results are capped at 200 entries (alphabetical, first 200), and returned as a JSON array. When
the cap is applied the response object MUST include `"truncated": true`. The response MUST include
`X-Cache-Age` and `X-Cache-TTL` headers indicating cache staleness in milliseconds. When
`projectsDir` is not configured (empty after trim), the agent SHALL log an info-level message and
return an empty project list with `"configured": false` in the response body. The `projectsDir`
value MUST be expanded via `os.homedir()` before any filesystem operation; path values containing
`..` segments after expansion SHALL be rejected with `400`. The expanded absolute path MUST begin
with `/home/` or `/Users/`; paths outside these prefixes SHALL be rejected with `400`.

#### Scenario: agent scans default directory
- **WHEN** `NEXUS_PROJECTS_DIR` is not set and `~/dev` contains `nx/` (has `.git`), `oo/`
  (has `.git`), `hl/` (has `.git`)
- **AND** `GET /projects/discovered` is called
- **THEN** response is `200` with three entries each having `name`, `path`, `activeSessions`,
  `totalSessions`, `registryId`

#### Scenario: agent scans custom directory
- **WHEN** `NEXUS_PROJECTS_DIR=/home/user/code` and `code/` contains `proj-a/`
  (has `package.json`), `proj-b/` (has `Cargo.toml`)
- **AND** `GET /projects/discovered` is called
- **THEN** response contains exactly two entries with correct `path` values

#### Scenario: depth=2 includes nested projects
- **WHEN** `NEXUS_PROJECTS_DIR=~/dev`, `~/dev/work/api/` has `package.json`, and
  `~/dev/personal/` has no marker but `~/dev/personal/blog/` has `.git`
- **AND** `GET /projects/discovered?depth=2` is called
- **THEN** response includes `work/api` and `personal/blog` but NOT `personal/` (no marker)

#### Scenario: non-project directories excluded
- **WHEN** `~/dev/tmp/` exists but contains no `.git`, `package.json`, or `Cargo.toml`
- **AND** `GET /projects/discovered` is called
- **THEN** `tmp` does NOT appear in the response

#### Scenario: symlinks are resolved and deduplicated within scan
- **WHEN** `~/dev/link` is a symlink pointing to `~/dev/nx`
- **AND** a cache-miss triggers a fresh scan
- **THEN** only one entry appears for the canonical path; broken symlinks are skipped silently
- **AND** the dedup set does not persist to the next scan cycle

#### Scenario: active session window is 1 hour
- **WHEN** `~/dev/oo/` is discovered and 2 sessions have `project = "oo"` with `last_seen = NOW() - 45 minutes`
- **AND** `GET /projects/discovered` is called
- **THEN** the `oo` entry has `activeSessions: 2` (sessions within 1-hour window count as active)

#### Scenario: sessions older than 1 hour not counted as active
- **WHEN** `~/dev/oo/` is discovered and 1 session has `project = "oo"` with `last_seen = NOW() - 61 minutes` and `status != "active"`
- **AND** `GET /projects/discovered` is called
- **THEN** the `oo` entry has `activeSessions: 0`

#### Scenario: directory does not exist
- **WHEN** `NEXUS_PROJECTS_DIR=/nonexistent`
- **AND** `GET /projects/discovered` is called
- **THEN** response is `200` with an empty array and no error

#### Scenario: cap at 200 entries with truncated flag
- **WHEN** `projects_dir` contains 300 qualifying subdirectories
- **AND** `GET /projects/discovered` is called
- **THEN** response body is `{ "projects": [...200 entries...], "truncated": true }`
  (alphabetical, first 200)

#### Scenario: tilde expansion prevents ENOENT
- **WHEN** `agent.projectsDir` is stored as `"~/dev"` in the database
- **AND** `GET /projects/discovered` is called
- **THEN** the path is expanded to an absolute path using `os.homedir()` before `readdirSync`;
  no ENOENT is thrown

#### Scenario: path traversal rejected
- **WHEN** `projectsDir` is set to `/home/user/dev/../../../etc`
- **AND** `GET /projects/discovered` is called
- **THEN** response is `400` with a descriptive error message

#### Scenario: path outside allowed prefix rejected
- **WHEN** `projectsDir` resolves to `/opt/projects` (not under `/home/` or `/Users/`)
- **AND** `GET /projects/discovered` is called
- **THEN** response is `400` with error "projectsDir must be under /home/ or /Users/"

#### Scenario: unconfigured projectsDir returns empty with flag
- **WHEN** `agent.projectsDir` is null or empty string
- **AND** `GET /projects/discovered` is called
- **THEN** response is `200` with `{ "projects": [], "truncated": false, "configured": false }`
  and an info log is emitted

#### Scenario: cache freshness headers present
- **WHEN** `GET /projects/discovered` is called and data is served from cache
- **THEN** response includes `X-Cache-Age` header with a positive integer (ms since last scan)
  and `X-Cache-TTL` header with the configured TTL in ms

### Requirement: discovered-project-type
`packages/core` MUST export a `DiscoveredProject` interface and the `AgentConfigSchema` SHALL
accept an optional `projects_dir` string field. The agent-internal wire type
`AgentDiscoveredProject` MUST carry `activeSessions: number`, `totalSessions: number`, and
`registryId: string | null` instead of `hasActiveSessions: boolean`. The Next.js client
MUST map `activeSessions` → `active_sessions` and `totalSessions` → `total_sessions` without
information loss; during a transition period where old agents may send `hasActiveSessions`,
the client MUST apply a graceful degradation shim.

#### Scenario: DiscoveredProject shape
- **WHEN** the TypeScript type is imported from `@nexus/core`
- **THEN** it has fields `name: string`, `path: string`, `active_sessions: number`,
  `total_sessions: number`, `registryId: string | null`

#### Scenario: AgentDiscoveredProject wire shape
- **WHEN** the agent serialises a project entry to JSON
- **THEN** the object has `activeSessions: number`, `totalSessions: number`,
  `registryId: string | null` and does NOT have `hasActiveSessions`

#### Scenario: AgentConfig with projects_dir
- **WHEN** a config entry `{ name: "homelab", host: "homelab", port: 7400, projects_dir: "~/dev" }`
  is parsed by `AgentConfigSchema`
- **THEN** it parses successfully with `projects_dir` set

#### Scenario: AgentConfig without projects_dir
- **WHEN** a config entry `{ name: "homelab", host: "homelab", port: 7400 }` is parsed
- **THEN** it parses successfully with `projects_dir` undefined

#### Scenario: graceful degradation shim
- **WHEN** the Next.js client receives a response from an old agent that has
  `hasActiveSessions: true` but no `activeSessions` field
- **THEN** the client maps `active_sessions` to `1` and `total_sessions` to `0` via the shim,
  and does not throw a type error

### Requirement: cross-machine project dedup
The Next.js client's `fetchDiscoveredProjects` aggregator SHALL merge projects that represent
the same repository on different machines into a single entry. The canonical identity key MUST
be the git remote URL (`git remote get-url origin`, resolved within 500 ms timeout); when no
git remote is available the key SHALL fall back to the normalized absolute path (symlinks
resolved, lowercased on macOS). On a dedup hit, `active_sessions` and `total_sessions` MUST be
summed across agents; `machineCount` MUST be incremented; the `agent` field SHALL retain the
first-reporter's value and MUST NOT be overwritten by subsequent agents.

#### Scenario: same repo on two agents deduplicates by git remote
- **WHEN** agent-A reports `{ name: "nx", path: "/home/alice/dev/nx", activeSessions: 1, ... }`
  with git remote `git@github.com:owner/nx.git`
- **AND** agent-B reports `{ name: "nx", path: "/Users/alice/dev/nx", activeSessions: 0, ... }`
  with git remote `git@github.com:owner/nx.git`
- **THEN** the aggregated result contains exactly one entry with `active_sessions: 1`,
  `machineCount: 2`, and `agent` equal to agent-A's name

#### Scenario: different projects with same name are NOT merged
- **WHEN** agent-A reports a project named `web` with git remote `git@github.com:team1/web.git`
- **AND** agent-B reports a project named `web` with git remote `git@github.com:team2/web.git`
- **THEN** the aggregated result contains two separate `web` entries

#### Scenario: no git remote falls back to normalized path
- **WHEN** a project has no git remote (local-only) and both agents report the same path
  after normalization
- **THEN** a single deduplicated entry is returned with summed counts

### Requirement: stale project eviction
The aggregated discovered project list SHALL evict projects that have not been reported by any
agent for more than 1 hour. Eviction is applied client-side on each aggregation cycle before
results are returned. The `lastSeenAt` timestamp is updated whenever a project appears in any
agent's response; it is NOT reset when the project is absent from a cycle.

#### Scenario: stale project is removed
- **WHEN** a project was last seen 61 minutes ago and no agent reports it in the current cycle
- **THEN** the project does NOT appear in the aggregated result

#### Scenario: recently seen project is retained
- **WHEN** a project was last seen 30 minutes ago and no agent reports it in the current cycle
  (agent is temporarily offline)
- **THEN** the project still appears in the aggregated result with its last-known counts

#### Scenario: project reappears after eviction
- **WHEN** a project was evicted (absent >1 h) and then reported again by an agent
- **THEN** it reappears in the result with fresh counts and an updated `lastSeenAt`

