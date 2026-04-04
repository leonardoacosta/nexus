## ADDED Requirements

### Requirement: Project Discovery
The agent SHALL expose a `ListProjects` RPC that returns all projects discoverable on this
machine, including both projects with active sessions and projects found in the Claude Code
projects directory.

#### Scenario: List projects on agent
- **WHEN** a client calls ListProjects
- **THEN** the response includes project entries from `~/.claude/projects/` directories
- **AND** projects with active sessions are included even if not in the projects directory
- **AND** each entry includes the project name and path

#### Scenario: No projects found
- **WHEN** a client calls ListProjects on a machine with no Claude Code projects
- **THEN** an empty list is returned with no error

### Requirement: Agent Status
External consumers SHALL be able to query each agent's connection status and identity
to build a topology view of all available machines.

#### Scenario: Agent responds to health check
- **WHEN** a client calls GetHealth on any agent
- **THEN** the response includes `agent_name` and `agent_host` identifying the machine
- **AND** the consumer can build a map of available agents and their projects
