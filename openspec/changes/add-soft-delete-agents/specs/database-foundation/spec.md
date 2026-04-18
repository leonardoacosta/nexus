## ADDED Requirements

### Requirement: Soft-delete for agents
The `agents` table MUST include a nullable `deletedAt` timestamp column. Removing an agent MUST set `deletedAt = NOW()` rather than physically deleting the row. Other tables in the schema (credentials, sessions, projects) follow their own lifecycle models and are OUT OF SCOPE for this requirement.

#### Scenario: User removes an agent from settings
- **GIVEN** an agent with id "homelab" exists
- **WHEN** the dashboard's saveAgentConfig calls the remove path
- **THEN** the row remains in the database but `deletedAt` is set to a non-null timestamp

### Requirement: Agent list queries default to live rows
Read queries that enumerate "all agents" or fetch "active agent by id" MUST filter `WHERE deletedAt IS NULL` unless explicitly requesting tombstoned records.

#### Scenario: Dashboard agent list after soft-delete
- **GIVEN** three agents exist, one with `deletedAt` set
- **WHEN** the dashboard fetches the agent list
- **THEN** only two agents are returned, and the soft-deleted one is not visible

### Requirement: Historical session joins tolerate soft-delete
Queries that join `sessions` to `agents` MUST still resolve `agent.id` when the agent has been soft-deleted, to preserve audit/display of historical sessions.

#### Scenario: Display of past session referencing removed agent
- **GIVEN** a session in the database references agent "homelab" and that agent has been soft-deleted
- **WHEN** the session is loaded for display
- **THEN** the agent join resolves (the row is still there) and the UI can display historical context
