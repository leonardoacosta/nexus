## ADDED Requirements

### Requirement: Credential manager reads the dotted Claude Code auth path

`cc-credential-manager`'s default credential path MUST be
`~/.claude/.credentials.json` (leading dot), matching the real Claude Code
OAuth file and `active-credential-watcher`. No code path in the credential
subsystem may default to the no-dot `~/.claude/credentials.json`.

#### Scenario: manager resolves the real auth file

- **GIVEN** `~/.claude/.credentials.json` exists on the agent host
- **WHEN** the credential manager reads its default path
- **THEN** it reads `~/.claude/.credentials.json`
- **AND** it does not look for `~/.claude/credentials.json`

#### Scenario: schema parses the real file shape

- **WHEN** the manager parses `~/.claude/.credentials.json`
- **THEN** it resolves `claudeAiOauth.accessToken`/`refreshToken`/`expiresAt`/`subscriptionType` without a schema-drift error

### Requirement: GET /credentials reflects the real active credential

`GET /credentials` MUST surface the real active Claude Code credential present
on the agent host. A single canonical source owns this; the endpoint MUST NOT
return an empty list when a valid `~/.claude/.credentials.json` exists.

#### Scenario: endpoint non-empty when auth file present

- **GIVEN** a valid `~/.claude/.credentials.json` on the agent host
- **WHEN** the dashboard requests `GET /credentials`
- **THEN** the response includes the active credential
- **AND** `activeFingerprint` is non-null

#### Scenario: endpoint empty only when no auth file

- **GIVEN** no `~/.claude/.credentials.json` on the agent host
- **WHEN** the dashboard requests `GET /credentials`
- **THEN** the response is an explicit empty result (not an error)
