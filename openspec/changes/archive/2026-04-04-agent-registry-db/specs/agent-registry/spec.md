# Spec: agent-registry

## ADDED Requirements

### Requirement: agents-table
The system SHALL maintain an `agents` PostgreSQL table as the authoritative registry for all
known `nexus-agent` instances.

#### Scenario: schema columns
Given the agents table exists,
When queried,
Then each row contains: `id` (hostname, PK), `name`, `host`, `port`, `projects_dir`, `enabled`,
`last_seen`, `created_at`.

#### Scenario: unique per machine
Given two deploys of nexus-agent on the same machine,
When both attempt self-registration with the same hostname,
Then only one row exists (upsert, not duplicate insert).

---

### Requirement: agent-self-registration
Each nexus-agent instance SHALL upsert its own row in the `agents` table on startup.

#### Scenario: first startup
Given no row exists for this machine's hostname,
When nexus-agent starts successfully,
Then a row is inserted with host, port, last_seen=now(), projects_dir defaulting to `$HOME/dev`.

#### Scenario: restart preserves user-edited projects_dir
Given a row exists with projects_dir edited to `/home/nyaptor/projects`,
When nexus-agent restarts,
Then projects_dir remains `/home/nyaptor/projects` (not overwritten by default).

#### Scenario: DB unavailable on startup
Given PostgreSQL is unreachable,
When nexus-agent starts,
Then a warning is logged and the agent continues serving HTTP (degraded — no self-registration).

---

### Requirement: get-agent-self-endpoint
`GET /agent/self` SHALL return the agent's own DB row as JSON.

#### Scenario: registered agent
Given a row exists for the current hostname,
When `GET /agent/self` is called,
Then HTTP 200 with `{id, name, host, port, projects_dir, enabled, last_seen}`.

#### Scenario: unregistered agent
Given no row exists (DB failure prevented self-registration),
When `GET /agent/self` is called,
Then HTTP 404 with `{error: "not registered"}`.

---

### Requirement: get-projects-discovered-endpoint
`GET /projects/discovered` SHALL return a list of git repositories under `projects_dir`.

#### Scenario: populated projects_dir
Given `projects_dir = /home/nyaptor/dev` with 15 git repos,
When `GET /projects/discovered` is called,
Then HTTP 200 with `{projects: [{name, path, active_sessions, total_sessions}], truncated: false}`.

#### Scenario: session cross-reference
Given a project `nx` has 2 active sessions in the DB,
When `/projects/discovered` is called,
Then the `nx` entry has `active_sessions: 2`.

#### Scenario: truncation at 100
Given `projects_dir` contains 150 git repos,
When `/projects/discovered` is called,
Then response contains exactly 100 projects and `truncated: true`.

#### Scenario: projects_dir not set
Given `projects_dir` is empty string in the DB,
When `/projects/discovered` is called,
Then HTTP 200 with `{projects: [], truncated: false}`.

---

## MODIFIED Requirements

### Requirement: dashboard-agent-loading
The dashboard SHALL load the agent list from the `agents` DB table instead of
`~/.config/nexus/dashboard.json`.

#### Scenario: agents in DB
Given two rows in the agents table (enabled=true),
When `getClient()` is called,
Then an `AgentClient` is constructed with both agents.

#### Scenario: empty DB — fallback
Given no rows in the agents table,
When `getClient()` is called,
Then an `AgentClient` is constructed with the localhost:7400 fallback.

#### Scenario: no dashboard.json file
Given `~/.config/nexus/dashboard.json` does not exist,
When `getClient()` is called,
Then no error is thrown (file is no longer read).

---

### Requirement: settings-agent-crud
The settings page SHALL persist agent changes to the `agents` table, not `dashboard.json`.

#### Scenario: add agent
Given the settings page submits a new agent `{name: "macbook", host: "100.64.0.2", port: 7400}`,
When `saveAgentConfig("add", agent)` is called,
Then a row is upserted in the agents table and the settings page reflects the new agent.

#### Scenario: remove agent
Given a row `{id: "macbook"}` exists in the agents table,
When `saveAgentConfig("remove", {name: "macbook"})` is called,
Then the row is deleted and the settings page no longer shows "macbook".

---

## REMOVED Requirements

### Requirement: dashboard-json-file-registry (removed)
`~/.config/nexus/dashboard.json` is no longer read or written by the dashboard.
`get-client.ts` file I/O is removed. `saveAgentConfig` no longer calls `writeFileSync`.
`resetClient()` is no longer called from settings actions.

### Requirement: nexus-projects-dir-ghost (removed)
`NEXUS_PROJECTS_DIR` is removed from `deploy/nexus-agent.service`.
`agents.toml` seeding block is removed from `deploy/install.sh`.
The env var bootstrap path in self-registration uses `process.env.NEXUS_PROJECTS_DIR` only as a
one-time fallback during first startup; after the DB row is created, the DB value is authoritative.
