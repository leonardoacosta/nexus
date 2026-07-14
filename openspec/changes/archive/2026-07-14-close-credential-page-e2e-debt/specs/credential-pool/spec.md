## MODIFIED Requirements

### Requirement: The system SHALL emit structured lifecycle events for credential operations
The system SHALL emit a structured log event for each credential lifecycle transition (lease, release,
cooldown entry, cooldown exit, stale release, predictive pre-rotation) with an `event` field using
the canonical naming scheme `credential.<action>`. These events form the integration contract for
future OTel/Sentry wiring. The corresponding `cc_profile_events` database row (renamed from
`credential_events` by `add-cc-credential-manager`) MUST also be persisted for each lease and
release transition.

#### Scenario: Lease event emitted
Given credential "c1" is available
When `POST /credentials/lease` successfully leases "c1"
Then a log entry with `event: "credential.leased"` and `id: "c1"` is emitted at INFO level

#### Scenario: Cooldown entry event emitted
Given credential "c1" is leased
When `POST /credentials/c1/report-rate-limit` is called
Then a log entry with `event: "credential.cooldown_entered"` and `id: "c1"` is emitted

#### Scenario: Cleanup timer errors logged not swallowed
Given the cleanup timer fires and `recoverExpiredCooldowns` throws an unexpected error
When the interval callback executes
Then the error is caught and logged at ERROR level; the timer continues to run on the next tick

#### Scenario: E2E-verified cc_profile_events persistence after lease and release (nx-b0ew)
- **Given** credential "c1" is available
- **When** `POST /credentials/lease` leases "c1" and a subsequent release call releases it
- **Then** a `cc_profile_events` row exists for the lease transition
- **And** a `cc_profile_events` row exists for the release transition
