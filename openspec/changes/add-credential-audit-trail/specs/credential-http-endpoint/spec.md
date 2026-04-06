## ADDED Requirements

### Requirement: Credential Access Audit Trail

The system SHALL emit a structured audit log entry on every credential access
event that decrypts or probes a credential secret. Audit entries MUST be
emitted at the HTTP handler layer (not the pool layer) so that caller context
(IP address, actor identity) is captured. Each audit entry MUST include:
`event` (string), `credential_id` (string), `actor` (string), `ip` (string),
`timestamp_iso` (ISO 8601 string), and an optional `detail` object.

The audit logger MUST use a dedicated child logger named `audit.credential`
created via `createLogger("audit.credential")` so that audit entries can be
filtered and forwarded independently of operational logs.

#### Scenario: Successful lease emits audit entry

- **WHEN** `POST /credentials/lease` succeeds and returns a decrypted credential
- **THEN** an audit log entry is emitted with `event: "credential.leased"`,
  `credential_id` matching the leased credential, `actor` matching the
  `leased_by` value from the request body, and `ip` from the caller's address

#### Scenario: Rate-limit auto-swap emits two audit entries

- **WHEN** `POST /credentials/{id}/report-rate-limit` triggers a cooldown and
  the pool returns a replacement credential
- **THEN** two audit entries are emitted: one with
  `event: "credential.cooldown"` for the rate-limited credential and one with
  `event: "credential.auto_swap"` for the replacement, linking both via a
  `detail.replaced_credential_id` field

#### Scenario: Rate-limit with no replacement emits single audit entry

- **WHEN** `POST /credentials/{id}/report-rate-limit` triggers a cooldown but
  no replacement credential is available
- **THEN** only one audit entry is emitted with
  `event: "credential.cooldown"` and no `credential.auto_swap` entry

#### Scenario: Health check emits audit entry

- **WHEN** `GET /credentials/{id}/health` decrypts and probes a credential
- **THEN** an audit log entry is emitted with
  `event: "credential.health_check"`, `credential_id`, `ip`, and
  `detail.healthy` reflecting the probe result

#### Scenario: Audit entries include caller IP

- **WHEN** a credential access request arrives with an `x-forwarded-for` header
- **THEN** the audit entry `ip` field contains the first address from that
  header
- **WHEN** no `x-forwarded-for` header is present
- **THEN** the audit entry `ip` field contains the direct socket peer address
