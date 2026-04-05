## MODIFIED Requirements

### Requirement: Token Type Safety — No Accidental Serialization
`CredentialAccount` MUST annotate `access_token` with `#[serde(skip)]`.

#### Scenario: serialized CredentialAccount omits access_token
- **WHEN** a `CredentialAccount` is serialized to JSON
- **THEN** the output does NOT contain the `access_token` field

#### Scenario: deserialization still populates access_token
- **WHEN** a credential JSON file is loaded from disk
- **THEN** `access_token` is populated normally

### Requirement: Constant-Time Secret Comparison
`validate_secret` MUST use constant-time comparison (subtle crate `ConstantTimeEq`).

#### Scenario: correct secret accepted
- **WHEN** the `X-Nexus-Secret` header matches
- **THEN** the request is accepted with no timing leak

#### Scenario: incorrect secret rejected
- **WHEN** the header does not match
- **THEN** HTTP 401 is returned

### Requirement: Atomic Credential Leasing
`CredentialPool.lease()` MUST use a single SQL transaction with `FOR UPDATE` row locking.

#### Scenario: concurrent leases receive distinct credentials
- **WHEN** two lease requests arrive simultaneously
- **THEN** each receives a different credential

#### Scenario: no available credentials returns null
- **WHEN** all credentials are `leased`
- **THEN** `lease()` returns `null` without error

### Requirement: Honest Credential Field Naming
The `value_encrypted` column MUST be renamed to `value_plaintext` via Drizzle migration.

#### Scenario: column accessible under new name
- **WHEN** the migration runs
- **THEN** the column is `value_plaintext` and existing values are preserved

### Requirement: Restrictive Credential File Permissions
All credential files written to `~/.config/nexus/` MUST use mode `0o600`.

#### Scenario: new credential file has 0600 permissions
- **WHEN** a credential file is written
- **THEN** `stat.mode & 0o777 == 0o600`
