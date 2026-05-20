# credential-pool Specification Delta

## ADDED Requirements

### Requirement: Credential pool reads agent host's CC credentials directory

The agent's credential-pool service SHALL read `~/.claude/.credentials/`
on the agent's host filesystem (resolved from `$HOME`) and project each
entry into the `/credentials` response shape. Reads occur on startup
and on demand per request — caching is optional.

#### Scenario: homelab reads its own credentials

- **GIVEN** homelab has at least one credential under
  `/home/nyaptor/.claude/.credentials/`
- **WHEN** the Mac dashboard fetches `GET /credentials`
- **THEN** the response `credentials` array has at least one entry
- **AND** each entry includes fingerprint, account label, and status

#### Scenario: missing credentials directory yields empty array

- **WHEN** `~/.claude/.credentials/` does not exist on the agent host
- **THEN** `GET /credentials` returns `{credentials: [], activeFingerprint: null}`
- **AND** the agent does NOT throw; logs a debug-level note about
  absent directory

#### Scenario: malformed credential file does not crash agent

- **GIVEN** a corrupted JSON file in the credentials directory
- **WHEN** the credential-pool reads the directory
- **THEN** the entry is skipped with a warning logged
- **AND** other valid entries still surface in `/credentials`

### Requirement: Active fingerprint reflects the CC convention

The `activeFingerprint` field in `/credentials` MUST reflect whichever
credential CC considers active on the host. Detection MUST follow the
canonical CC convention (symlink, marker file, or env hint —
implementer verifies on disk what CC actually uses).

#### Scenario: symlink-based active fingerprint

- **GIVEN** CC marks active credentials via a symlink at
  `~/.claude/.credentials/active`
- **WHEN** the credential-pool reads the dir
- **THEN** `activeFingerprint` equals the fingerprint of the file the
  symlink resolves to

#### Scenario: no active marker yields null

- **GIVEN** no active-credential marker is detectable
- **WHEN** the credential-pool reads the dir
- **THEN** `activeFingerprint` is `null` and `credentials` still
  enumerates all present entries

### Requirement: Credential metadata projected into response rows

Each credential entry in the `/credentials` array MUST include at least:
`fingerprint` (deterministic hash of the credential payload), `account`
(label or email if available from the credential file), `created_at`
(file mtime as ISO-8601), and `status` (one of `active`, `available`,
`expired` based on the fingerprint match + payload expiry if applicable).

#### Scenario: response row has expected keys

- **GIVEN** one credential file with mtime today
- **WHEN** `GET /credentials` is fetched
- **THEN** the first row has non-null `fingerprint`, `created_at`
  (ISO-8601), `status` (one of the enum values)
- **AND** `account` may be null if the credential file doesn't include
  it

#### Scenario: active row has status="active"

- **GIVEN** the activeFingerprint matches a specific entry
- **WHEN** the response is built
- **THEN** that entry has `status="active"`
- **AND** all other entries have `status="available"` (or `expired` if
  expiry has passed)
