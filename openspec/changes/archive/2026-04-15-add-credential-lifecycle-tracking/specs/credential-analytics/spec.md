# credential-analytics — Spec Delta

## ADDED Requirements

### Requirement: Credential events table schema

A `credential_events` table MUST exist with the following columns:
- `id` (text, PK) — UUID
- `credentialId` (text, NOT NULL) — FK to credentials.id
- `eventType` (text, NOT NULL) — one of: `leased`, `released`, `cooldown_entered`, `cooldown_exited`, `stale_lease_released`, `primary_swap`, `promoted`, `deleted`, `added`, `metadata_refreshed`
- `sessionId` (text, nullable) — the session or actor that triggered the event
- `metadata` (jsonb, nullable) — event-specific data (e.g., cooldown_until, previous_primary_id)
- `createdAt` (timestamp, NOT NULL, default now)

The table MUST have an index on `(credentialId, createdAt)` for per-credential timeline queries and an index on `createdAt` for retention cleanup.

#### Scenario: table accepts lifecycle events
- **Given** the `credential_events` table exists
- **When** a credential is leased, released, and rate-limited in sequence
- **Then** three rows exist with event_types `leased`, `released`, `cooldown_entered` in chronological order

#### Scenario: retention cleanup deletes old events
- **Given** the retention scheduler runs daily
- **When** credential events older than 30 days exist
- **Then** those events are deleted and recent events are preserved
