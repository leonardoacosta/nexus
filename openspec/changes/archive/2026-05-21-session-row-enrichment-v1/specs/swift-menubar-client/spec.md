# swift-menubar-client Specification Delta

## ADDED Requirements

### Requirement: SessionRow surfaces project + branch as primary identity

The Nexus.app SessionsView SHALL render each row with a project label
as the primary identity. The label degrades through this chain:
`gitOwnerRepo` → `projectId` → `cwd basename` → `—`. When `branch`
is present, it follows after a `·` separator.

#### Scenario: row with gitOwnerRepo shows owner/repo

- **GIVEN** a session row has `gitOwnerRepo=leonardoacosta/oo` and
  `branch=feat/auth-refactor`
- **WHEN** SessionsView renders the row
- **THEN** the primary line shows `leonardoacosta/oo · feat/auth-refactor`

#### Scenario: row with projectId only shows projectId

- **GIVEN** `gitOwnerRepo=null`, `projectId=oo`, `branch=null`
- **WHEN** the row renders
- **THEN** the primary line shows `oo`

#### Scenario: row with neither shows cwd basename

- **GIVEN** all project fields null but `cwd=/home/nyaptor/dev/oo`
- **WHEN** the row renders
- **THEN** the primary line shows `oo` (the trailing path segment)

#### Scenario: row with no resolvable identity shows dash

- **GIVEN** all project fields null AND `cwd` is empty or null
- **WHEN** the row renders
- **THEN** the primary line shows `—` (the existing fallback)

### Requirement: SessionRow secondary line shows model + cost + idle

The row SHALL render a secondary line containing: model · cost · idle
indicator. The cost displays `$N.NN` when `totalCostUsd > 0`, hidden
when null/zero. The idle indicator displays `Nm idle` when
`idleSince` is set, else duration since `startedAt` as `Nm` or `Nh`.

#### Scenario: row with cost + idle shows both

- **GIVEN** `model=claude-opus-4-7`, `totalCostUsd=0.42`,
  `idleSince=t-12min`
- **WHEN** the row renders
- **THEN** secondary line includes `claude-opus-4-7 · $0.42 · 12m idle`

#### Scenario: row without cost suppresses dollar segment

- **GIVEN** `totalCostUsd=null`
- **WHEN** the row renders
- **THEN** secondary line does NOT include `$0.00` or `$null`
- **AND** the cost segment is omitted entirely

#### Scenario: row never-idle shows runtime duration instead

- **GIVEN** `idleSince=null`, `startedAt=t-45min`
- **WHEN** the row renders
- **THEN** secondary line shows `45m` (active duration)

### Requirement: SessionRow trailing column shows status + pid + agent

The row SHALL render a trailing column with the existing status pill
and pinned chip (no change), plus PID and origin agent name as
muted-text triage anchors.

#### Scenario: trailing column has status + pid + agent

- **GIVEN** `status=active`, `pid=2537933`, `originAgent=local`
- **WHEN** the row renders
- **THEN** trailing column shows `active · pinned` chips above
  `pid 2537933 · local` muted text
