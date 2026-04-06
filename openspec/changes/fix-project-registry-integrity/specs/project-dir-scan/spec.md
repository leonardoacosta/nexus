## MODIFIED Requirements

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
