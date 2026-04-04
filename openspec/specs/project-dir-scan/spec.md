# project-dir-scan Specification

## Purpose
TBD - created by archiving change add-project-management. Update Purpose after archive.
## Requirements
### Requirement: project-dir-scan
The nexus-agent SHALL read `NEXUS_PROJECTS_DIR` env var (default: `~/dev`) at startup and store it in `AppState`. `GET /projects/discovered` MUST accept an optional `depth` query parameter (integer 1–3, default 1) and SHALL recursively scan `projects_dir` up to `depth` levels. A directory MUST be included only if it contains a project marker at its root: `.git/` directory, `package.json`, or `Cargo.toml`. Symlinks SHALL be skipped to prevent cycles. The scan MUST complete within 5 seconds; entries discovered before timeout ARE returned. Results MUST be merged with active session counts from `SessionRegistry`, capped at 200 entries (alphabetical, first 200), and returned as a JSON array. When the cap is applied the response object MUST include `"truncated": true`.

#### Scenario: agent scans default directory
Given `NEXUS_PROJECTS_DIR` is not set and `~/dev` contains `nx/` (has `.git`), `oo/` (has `.git`), `hl/` (has `.git`)
When `GET /projects/discovered` is called
Then response is `200` with three entries, each having `name`, `path`, `active_sessions`, `total_sessions`

#### Scenario: agent scans custom directory
Given `NEXUS_PROJECTS_DIR=/home/user/code` and `code/` contains `proj-a/` (has `package.json`), `proj-b/` (has `Cargo.toml`)
When `GET /projects/discovered` is called
Then response contains exactly two entries with correct `path` values

#### Scenario: depth=2 includes nested projects
Given `NEXUS_PROJECTS_DIR=~/dev`, `~/dev/work/api/` has `package.json`, and `~/dev/personal/` has no marker but `~/dev/personal/blog/` has `.git`
When `GET /projects/discovered?depth=2` is called
Then response includes `work/api` and `personal/blog` but NOT `personal/` (no marker)

#### Scenario: non-project directories excluded
Given `~/dev/tmp/` exists but contains no `.git`, `package.json`, or `Cargo.toml`
When `GET /projects/discovered` is called
Then `tmp` does NOT appear in the response

#### Scenario: symlinks are skipped
Given `~/dev/link` is a symlink to `~/dev/nx`
When `GET /projects/discovered` is called
Then `link` does NOT appear in the response (only real directories)

#### Scenario: live sessions merge into discovered list
Given `~/dev/oo/` is discovered and 2 sessions in the registry have `project = "oo"`
When `GET /projects/discovered` is called
Then the `oo` entry has `active_sessions: 2`

#### Scenario: directory does not exist
Given `NEXUS_PROJECTS_DIR=/nonexistent`
When `GET /projects/discovered` is called
Then response is `200` with an empty array and no error

#### Scenario: cap at 200 entries with truncated flag
Given `projects_dir` contains 300 qualifying subdirectories
When `GET /projects/discovered` is called
Then response body is `{ "projects": [...200 entries...], "truncated": true }` (alphabetical, first 200)

### Requirement: discovered-project-type
`packages/core` MUST export a `DiscoveredProject` interface and the `AgentConfigSchema` SHALL accept an optional `projects_dir` string field.

#### Scenario: DiscoveredProject shape
Given the TypeScript type is imported from `@nexus/core`
Then it has fields `name: string`, `path: string`, `active_sessions: number`, `total_sessions: number`

#### Scenario: AgentConfig with projects_dir
Given a config entry `{ name: "homelab", host: "homelab", port: 7400, projects_dir: "~/dev" }`
When parsed by `AgentConfigSchema`
Then it parses successfully with `projects_dir` set

#### Scenario: AgentConfig without projects_dir
Given a config entry `{ name: "homelab", host: "homelab", port: 7400 }`
When parsed by `AgentConfigSchema`
Then it parses successfully with `projects_dir` undefined

