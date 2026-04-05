## MODIFIED Requirements

### Requirement: Correct DiscoveredProjectsResponse Shape
The `GET /projects/discovered` handler MUST return `{ projects, truncated: boolean }` matching the
`DiscoveredProjectsResponse` core type.

#### Scenario: response includes truncated field
- **WHEN** `GET /projects/discovered` is called and results fit within the limit
- **THEN** the response contains `{ projects: [...], truncated: false }`

#### Scenario: truncated flag set when limit reached
- **WHEN** discovered projects exceed the page limit
- **THEN** the response contains `{ projects: [...], truncated: true }`

### Requirement: Path Normalization on projectsDir
The handler MUST expand `~` to the home directory and reject relative paths.

#### Scenario: tilde expanded
- **WHEN** `projectsDir` is `~/projects`
- **THEN** the handler reads `${os.homedir()}/projects`

#### Scenario: relative path rejected
- **WHEN** `projectsDir` is a relative path
- **THEN** HTTP 400 is returned with `"projectsDir must be an absolute path"`

### Requirement: Error-Surfacing Directory Read
`fs.readdirSync` failures MUST surface an error field rather than returning an empty list.

#### Scenario: permission error surfaced
- **WHEN** `fs.readdirSync` throws `EACCES`
- **THEN** the response includes `{ error: "EACCES: permission denied", projects: [] }`

#### Scenario: empty directory returns no error
- **WHEN** the directory is empty
- **THEN** the response includes `{ projects: [], truncated: false }` with no `error` field

### Requirement: Parallel Multi-Agent Discovery
Project aggregation across agents MUST use `Promise.all` for concurrent fetching.

#### Scenario: N agents fetched in parallel
- **WHEN** 3 agents are configured
- **THEN** all 3 HTTP requests are issued simultaneously

### Requirement: Project Deduplication Across Agents
Projects MUST be deduplicated by `(name, pathHash)` with a `machineCount` field.

#### Scenario: same project on two agents deduplicated
- **WHEN** two agents report the same `(name, path)`
- **THEN** one card is returned with `machineCount: 2`

#### Scenario: different projects not deduplicated
- **WHEN** two projects have different paths
- **THEN** both appear as separate cards

### Requirement: Observability in Route Handlers
All project route catch blocks MUST call `logger.error()`. Successful returns MUST call `logger.debug()`.

#### Scenario: readdirSync failure logged
- **WHEN** `fs.readdirSync` throws
- **THEN** `logger.error({ err }, "project discovery failed")` is called

#### Scenario: successful aggregation logged
- **WHEN** projects are returned successfully
- **THEN** `logger.debug({ count }, "projects aggregated")` is called
