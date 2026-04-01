# database-foundation Specification

## Purpose
TBD - created by archiving change add-sqlite-store. Update Purpose after archive.
## Requirements
### Requirement: The system MUST provide a SQLite database with schema migrations
The agent MUST create and manage `~/.config/nexus/nexus.db` with WAL mode enabled, schema versioning via `PRAGMA user_version`, and a shared `NexusDb` wrapper accessible to all services.

#### Scenario: First startup creates database
Given no nexus.db exists at `~/.config/nexus/`
When the agent starts
Then it creates the database, enables WAL mode, runs all migrations to the latest version, and logs "Database initialized at version N"

#### Scenario: Subsequent startup with current version
Given nexus.db exists at version 1
When the agent starts and expects version 1
Then it skips migrations and proceeds normally

#### Scenario: Subsequent startup with older version
Given nexus.db exists at version 1
When the agent starts and expects version 2
Then it runs migration 1→2 and updates user_version to 2

#### Scenario: Database from future version
Given nexus.db exists at version 3
When the agent starts and only knows up to version 2
Then it logs an error and refuses to start (forward-compatibility guard)

