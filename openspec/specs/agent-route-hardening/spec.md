# agent-route-hardening Specification

## Purpose
TBD - created by archiving change agent-route-hardening. Update Purpose after archive.
## Requirements
### Requirement: Legacy CWD Resolution Fallback

`readProcessCwd` SHALL resolve a legacy session row with an empty `cwd` by falling back to a `/proc/<pid>/cwd` readlink instead of returning undefined.

#### Scenario: Legacy empty-cwd row resolves a real cwd

- **WHEN** `readProcessCwd` is called for a legacy session row whose stored `cwd` is empty but whose `/proc/<pid>/cwd` readlink succeeds
- **THEN** the function returns the readlink-resolved working directory rather than undefined

#### Scenario: Readlink unavailable yields no fabricated cwd

- **WHEN** `readProcessCwd` is called for an empty-cwd row whose `/proc/<pid>/cwd` readlink fails or is inaccessible
- **THEN** the function returns undefined without fabricating a path and the failure path is unchanged

### Requirement: Projects-Discovered Error Status

The projects-discovered route MUST return HTTP 500 when `readdirSync` throws so clients can distinguish a scan failure from an empty result.

#### Scenario: Readdir failure yields HTTP 500

- **WHEN** the projects-discovered handler invokes `readdirSync` and it throws
- **THEN** the handler responds with HTTP status 500 rather than HTTP 200 with an empty list

