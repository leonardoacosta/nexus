# tui-config-watcher Specification

## Purpose
TBD - created by archiving change fix-tui-agent-cleanup. Update Purpose after archive.
## Requirements
### Requirement: Config Watcher Propagates to NexusClient
When `agents.toml` is modified on disk and successfully re-parsed, the reloaded `NexusConfig` SHALL be delivered to the `background_task` so that the `NexusClient` updates its agent list. New agents SHALL be connected. Agents removed from the config SHALL be dropped from the client. The existing toast notification SHALL remain.

#### Scenario: New agent added to config
- **WHEN** a user edits `agents.toml` to add a new agent entry
- **THEN** the config watcher re-parses the file, sends the new config to the background task, and the `NexusClient` adds and connects to the new agent within the next poll cycle

#### Scenario: Agent removed from config
- **WHEN** a user edits `agents.toml` to remove an existing agent entry
- **THEN** the config watcher re-parses the file, sends the new config to the background task, and the `NexusClient` drops the removed agent connection

#### Scenario: Config parse failure
- **WHEN** `agents.toml` is saved with invalid TOML syntax
- **THEN** the config watcher logs a warning and does NOT update the `NexusClient` or show a toast

