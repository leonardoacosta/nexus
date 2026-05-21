# session-persistence Specification Delta

## ADDED Requirements

### Requirement: Agent resolves git project for every new session

The agent SHALL resolve git project metadata (`gitProvider`,
`gitOwnerRepo`, `projectId`) for every new session record. Resolution
MUST happen at ingest time (session_start hook OR process-watcher's
first poll), not at query time.

#### Scenario: cwd with git remote populates owner/repo

- **GIVEN** a session starts in `/home/nyaptor/dev/oo` and `git remote
  get-url origin` returns `https://github.com/leonardoacosta/oo.git`
- **WHEN** the agent ingests the session
- **THEN** the persisted row has `gitProvider=github`,
  `gitOwnerRepo=leonardoacosta/oo`, and `projectId=<oo project's id>`

#### Scenario: cwd outside a git repo emits null

- **WHEN** a session starts in `/tmp` (not a git repo)
- **THEN** the persisted row has `gitProvider=null`,
  `gitOwnerRepo=null`, `projectId=null`
- **AND** the agent does NOT throw; row insert proceeds

#### Scenario: cwd lookup failure is fail-soft

- **WHEN** `git remote get-url origin` exits non-zero or the cwd is
  unreadable
- **THEN** the resolver returns null for all three fields
- **AND** logs a debug-level note with the cwd

### Requirement: Resolver result cached per cwd for 30 seconds

The resolver SHALL cache `{cwd → result}` for 30 seconds. The
process-watcher's polling loop (default 30s tick) MUST NOT re-shell
`git remote` on every poll for unchanged cwds.

#### Scenario: second poll within 30s hits cache

- **GIVEN** the resolver was called for cwd `/home/nyaptor/dev/oo` at t=0
- **WHEN** the process-watcher polls again at t=15 with the same cwd
- **THEN** NO `git` subprocess spawns
- **AND** the cached result is returned

#### Scenario: cache expires after 30s

- **WHEN** the resolver is called for the same cwd at t=31
- **THEN** a fresh `git remote` subprocess is spawned
- **AND** the new result replaces the cached entry

### Requirement: process-watcher writes project fields

The process-watcher SHALL replace its hard-coded `projectId: null` with
a call to the git-project resolver before upserting a session row.
Existing rows with null project fields MAY be re-enriched on the next
poll.

#### Scenario: existing null-project row gets enriched on next poll

- **GIVEN** an active session row with `projectId: null` already exists
- **WHEN** the next poll fires and the resolver returns a project
- **THEN** the session row's `gitProvider`, `gitOwnerRepo`, `projectId`
  are updated to the resolved values
- **AND** `lastActivity` reflects the poll timestamp
