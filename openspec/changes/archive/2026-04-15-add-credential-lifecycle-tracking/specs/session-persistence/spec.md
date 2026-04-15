# session-persistence — Spec Delta

## MODIFIED Requirements

### Requirement: Session-credential binding from socket events

When a `session_start` socket event includes a `credentialFingerprint` field, the session manager MUST look up the corresponding credential by fingerprint and populate `sessions.credentialId` and `sessions.credentialFingerprint` on the session row. If the fingerprint is not provided or does not match any credential, both fields remain NULL (best-effort binding).

#### Scenario: session bound to credential via fingerprint
- **Given** the agent has a credential with fingerprint "abc123" in the DB
- **When** a `session_start` socket event arrives with `credentialFingerprint: "abc123"`
- **Then** the session row is created with `credentialId` set to the matching credential's ID and `credentialFingerprint: "abc123"`

#### Scenario: session without credential fingerprint
- **Given** a CC session starts without sending credentialFingerprint
- **When** the `session_start` event is processed
- **Then** the session row is created with `credentialId: NULL` and `credentialFingerprint: NULL` (existing behavior preserved)

#### Scenario: session with unknown fingerprint
- **Given** no credential in the DB has fingerprint "unknown123"
- **When** a `session_start` event arrives with `credentialFingerprint: "unknown123"`
- **Then** the session row is created with `credentialId: NULL` and `credentialFingerprint: "unknown123"` (fingerprint stored for future matching)
