# Agent Security

## ADDED Requirements

### Requirement: Agent IPC Socket Permission Hardening

The agent SHALL set the UNIX hook-ingest socket file to mode 0600 immediately after binding, on both the default path and any `NEXUS_SOCKET` override, matching the repo's 0600 convention for credential files.

#### Scenario: Socket file is owner-only after bind

- **WHEN** the agent binds its hook-ingest UNIX socket
- **THEN** the socket file's mode is 0600, and processes running as other uids receive a permission error on connect

#### Scenario: Same-uid ingest unaffected

- **WHEN** `nexus-emit` (running as the agent's uid) sends a hook event after the hardening
- **THEN** the event is ingested exactly as before
