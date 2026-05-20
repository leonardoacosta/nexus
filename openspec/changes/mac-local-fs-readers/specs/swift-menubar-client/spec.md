# swift-menubar-client Specification Delta

## ADDED Requirements

### Requirement: SpecsView reads local filesystem in addition to remote agent

The Nexus.app SpecsView SHALL read OpenSpec proposals from local
filesystem workspace roots (default `~/dev/*/openspec/changes/`) AND from
the configured homelab agent, merging the results into a single list. The
local source MUST take precedence on key collision `(project, name)`.

#### Scenario: local specs appear in SpecsView even when homelab has none

- **GIVEN** the operator has open proposals at `~/dev/nx/openspec/changes/foo/`
- **AND** the homelab agent's `GET /specs` returns `[]`
- **WHEN** the operator opens Nexus.app's Specs tab
- **THEN** the SpecsView shows at least the local proposal `foo`
- **AND** the tri-state markers (`hasProposal/hasDesign/hasTasks`) reflect
  actual filesystem presence

#### Scenario: spec with no openspec dir is skipped

- **WHEN** a workspace root contains a project directory WITHOUT
  `openspec/changes/`
- **THEN** the local reader produces zero entries for that project
- **AND** no error surfaces in the UI

#### Scenario: missing `~/dev` directory is tolerated

- **WHEN** the operator's `~/dev` directory does not exist
- **THEN** the local reader returns `[]` without error
- **AND** the SpecsView falls back to remote-only data

### Requirement: CredentialsView reads local Claude credentials

The Nexus.app CredentialsView SHALL read the Mac's Claude Code
credentials from `~/.claude/.credentials/` (or the configured CC
credentials path) AND from any homelab credentials feed, merging by
credential fingerprint. The local source MUST take precedence on
fingerprint collision.

#### Scenario: local credentials appear in CredentialsView

- **GIVEN** the operator has at least one entry under `~/.claude/.credentials/`
- **WHEN** the operator opens Nexus.app's Credentials tab
- **THEN** the CredentialsView shows the local credential entry
- **AND** the `activeFingerprint` field reflects the currently-active credential

#### Scenario: missing credentials dir produces empty list, no error

- **WHEN** `~/.claude/.credentials/` does not exist
- **THEN** the local reader returns `{credentials: [], activeFingerprint: null}`
- **AND** the UI shows an empty state without crash

### Requirement: Workspace roots are configurable

Nexus.app SHALL expose workspace-roots configuration in Settings so the
operator can add or remove directories scanned by the local readers. The
default workspace root list MUST include `~/dev/*/openspec/`.

#### Scenario: default workspace root is ~/dev

- **GIVEN** Nexus.app is launched for the first time
- **WHEN** SpecsLocalReader is invoked
- **THEN** it scans `~/dev/*/openspec/changes/` by default
- **AND** any matching project produces SpecSummary entries

#### Scenario: operator adds a custom workspace root

- **GIVEN** the operator adds `~/work/clientX` to workspace roots via Settings
- **WHEN** SpecsLocalReader is invoked
- **THEN** it scans BOTH `~/dev/*/openspec/changes/` AND
  `~/work/clientX/openspec/changes/`
- **AND** the SpecsView shows entries from both roots

### Requirement: NexusAggregateClient merges local + remote sources

NexusAggregateClient SHALL merge local-reader output with remote agent
fetches for specs and credentials. The `NexusAggregateClient.fetchSpecs()`
and `fetchCredentials()` methods MUST invoke local readers AND remote
homelab fetches in parallel, merging results by key with local-wins
precedence.

#### Scenario: parallel fetch is faster than sequential

- **WHEN** the SpecsView mounts
- **THEN** the local reader and homelab fetch run concurrently
- **AND** the merged result is available within max(local-time, remote-time) — NOT their sum

#### Scenario: local-wins on collision

- **GIVEN** a spec with key `(project=nx, name=foo)` exists BOTH on the
  local filesystem AND in the homelab response
- **WHEN** the aggregate client merges results
- **THEN** the local entry is kept
- **AND** the homelab entry is discarded

#### Scenario: homelab unreachable does not block local data

- **WHEN** the homelab agent is offline or unreachable
- **THEN** the local reader output is still surfaced
- **AND** the UI does not show an empty state — it shows local-only data
