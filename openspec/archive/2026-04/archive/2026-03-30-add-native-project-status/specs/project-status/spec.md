# Capability: Project Status

Native per-project status queries via HTTP and gRPC. Returns beads, git, and openspec state
without requiring a Claude Code session.

## ADDED Requirements

### Requirement: Project Code Resolution

The system SHALL resolve project codes (e.g., `oo`, `nx`, `co`) to filesystem paths using
the project registry at `~/.claude/scripts/config/projects.json`.

#### Scenario: Known project code
- **WHEN** a status request arrives for project code `oo`
- **THEN** the system resolves it to the registered filesystem path
- **AND** uses that path as the working directory for status commands

#### Scenario: Unknown project code
- **WHEN** a status request arrives for an unregistered project code
- **THEN** the system returns a 404 / NOT_FOUND response

#### Scenario: Fallback resolution
- **WHEN** a project code is not in the registry
- **AND** a directory exists at `~/dev/<code>/`
- **THEN** the system uses that directory as a fallback

### Requirement: Beads Status Collection

The system SHALL collect beads issue tracking status by executing `bd` CLI commands
in the project's working directory.

#### Scenario: Project with beads initialized
- **WHEN** beads status is requested for a project with `.beads/` directory
- **THEN** the system returns ready count, open count, blocked count, and ready issue details

#### Scenario: Project without beads
- **WHEN** beads status is requested for a project without `.beads/`
- **THEN** the system returns an empty beads status (all counts zero)

### Requirement: Git Status Collection

The system SHALL collect git repository state for a project.

#### Scenario: Git repository
- **WHEN** git status is requested for a project that is a git repository
- **THEN** the system returns current branch, HEAD SHA, recent commits, and working tree status

#### Scenario: Non-git directory
- **WHEN** git status is requested for a project that is not a git repository
- **THEN** the system returns an empty git status

### Requirement: OpenSpec Status Collection

The system SHALL collect OpenSpec specification and change proposal state.

#### Scenario: Project with openspec
- **WHEN** spec status is requested for a project with `openspec/` directory
- **THEN** the system returns spec count, active change count, and change names

#### Scenario: Project without openspec
- **WHEN** spec status is requested for a project without `openspec/`
- **THEN** the system returns an empty spec status

### Requirement: Response Caching

The system SHALL cache status responses with a configurable TTL (default 30 seconds).

#### Scenario: Cached response
- **WHEN** a status request arrives within the cache TTL
- **THEN** the system returns the cached response without re-executing commands

#### Scenario: Fresh request
- **WHEN** a status request includes a `fresh` flag
- **THEN** the system bypasses the cache and executes commands fresh

### Requirement: Aggregated Status Endpoint

The system SHALL provide an aggregated endpoint that returns beads, git, and openspec
status in a single response.

#### Scenario: Aggregated HTTP request
- **WHEN** `GET /project/:code/status` is requested
- **THEN** the system returns all three status types in a single JSON response

#### Scenario: Individual HTTP requests
- **WHEN** `GET /project/:code/beads`, `/git`, or `/specs` is requested
- **THEN** the system returns only the requested status type

### Requirement: gRPC Access

The system SHALL expose project status via a `GetProjectStatus` gRPC RPC.

#### Scenario: gRPC status request
- **WHEN** a `GetProjectStatus` request is received with a project code
- **THEN** the system returns the same data as the HTTP aggregated endpoint
