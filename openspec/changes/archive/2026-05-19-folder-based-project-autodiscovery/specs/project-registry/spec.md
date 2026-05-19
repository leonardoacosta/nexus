## ADDED Requirements

### Requirement: Folder-based project auto-discovery

The agent MUST scan configured dev-roots for directories containing `.git` OR
`openspec/`, at startup and on a periodic interval, and persist discovered
projects via `db/project-registry`. Discovery MUST NOT require manual
registration or a hand-maintained `projects.json`.

#### Scenario: discovers a repo on the agent host

- **GIVEN** a dev-root containing a directory with `.git` and `openspec/`
- **WHEN** the agent starts (or the periodic scan runs)
- **THEN** that project appears in `db/project-registry`
- **AND** it is not gated behind a static `projects.json`

### Requirement: spec-watcher consumes the project registry

spec-watcher MUST enumerate the projects it polls from the auto-discovered
`db/project-registry`, so `/specs` reflects openspec changes present on the
agent host.

#### Scenario: specs surface for a discovered repo

- **GIVEN** a discovered project with `openspec/changes/<slug>/`
- **WHEN** spec-watcher polls
- **THEN** `GET /specs` includes that change (no longer `[]`)

### Requirement: /projects aggregates registry and excludes hidden

`GET /projects` MUST aggregate the discovered registry and MUST omit any
project whose `hidden` flag is set.

#### Scenario: hidden project omitted

- **GIVEN** a discovered project flagged hidden
- **WHEN** the dashboard requests `GET /projects`
- **THEN** that project is not in the response

### Requirement: Removable project reference persists across rescans

A project MUST be removable via a persisted `hidden` flag set through `PATCH
/projects/:id`. The auto-discovery scanner MUST treat the hidden flag as
sticky — re-scanning a hidden project's folder MUST NOT clear `hidden`.

#### Scenario: hide survives a rescan

- **GIVEN** a discovered project the user has hidden
- **WHEN** the periodic scanner runs again over its folder
- **THEN** the project remains hidden and absent from `GET /projects`

#### Scenario: dashboard can remove a project

- **WHEN** the user removes a project in the dashboard ProjectsView
- **THEN** a `PATCH /projects/:id` sets `hidden`
- **AND** the project disappears from the list and stays gone
