## ADDED Requirements

### Requirement: project-dir-scan
The nexus-agent SHALL read `NEXUS_PROJECTS_DIR` env var (default: `~/dev`) at startup and store it in `AppState`. `GET /projects/discovered` MUST scan that directory's immediate children, filter for directories, merge each with active session counts from `SessionRegistry`, and return a JSON array of `DiscoveredProject`.

#### Scenario: agent scans default directory
Given `NEXUS_PROJECTS_DIR` is not set and `~/dev` contains `nx/`, `oo/`, `hl/`
When `GET /projects/discovered` is called
Then response is `200` with three entries, each having `name`, `path`, `active_sessions`, `total_sessions`

#### Scenario: agent scans custom directory
Given `NEXUS_PROJECTS_DIR=/home/user/code` and `code/` contains `proj-a/`, `proj-b/`
When `GET /projects/discovered` is called
Then response contains exactly two entries with correct `path` values

#### Scenario: live sessions merge into discovered list
Given `~/dev/oo/` is discovered and 2 sessions in the registry have `project = "oo"`
When `GET /projects/discovered` is called
Then the `oo` entry has `active_sessions: 2`

#### Scenario: directory does not exist
Given `NEXUS_PROJECTS_DIR=/nonexistent`
When `GET /projects/discovered` is called
Then response is `200` with an empty array and no error

#### Scenario: cap at 200 entries
Given `projects_dir` contains 300 subdirectories
When `GET /projects/discovered` is called
Then response contains at most 200 entries (alphabetical order, first 200)

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
