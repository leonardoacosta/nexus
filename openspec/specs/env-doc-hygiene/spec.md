# env-doc-hygiene Specification

## Purpose

Defines the documentation-completeness contract the nightly H1 audit checks against: every
environment variable read in source must be either documented in `.env.example` or named in its
cross-reference block pointing to its canonical secrets-file home, and operator-facing comments
about how a variable is set must be truthful.
## Requirements
### Requirement: Every source-read environment variable SHALL be documented or cross-referenced in .env.example

An environment variable read anywhere in this repository's source SHALL either have its own entry
in `.env.example`, or be named in `.env.example`'s Secrets-File Variables cross-reference block
when its canonical home is `deploy/secrets.env.example`, unless it is on the deliberately-deferred
list recorded in that file's history.

#### Scenario: A spec-mandated fallback variable is documented despite being deprecated

- **GIVEN** an environment variable read as a backward-compatibility fallback mandated by an
  OpenSpec capability spec
- **WHEN** `.env.example` is inspected
- **THEN** the variable has an entry with a comment explaining its deprecated/fallback status
- **AND** the source code fallback that reads it is unchanged

#### Scenario: A secrets-file-homed variable is cross-referenced

- **GIVEN** an environment variable whose canonical documentation lives in
  `deploy/secrets.env.example`
- **WHEN** `.env.example`'s Secrets-File Variables block is inspected
- **THEN** the variable is named in that block

#### Scenario: Retention-day and poll-interval vars are documented (plan 036)

- **GIVEN** `CREDENTIALS_RETENTION_DAYS`, `GIT_EVENTS_RETENTION_DAYS`,
  `PROJECT_STATUS_SNAPSHOTS_RETENTION_DAYS`, `SPEC_SNAPSHOTS_RETENTION_DAYS`,
  `NEXUS_TAILSCALE_POLL_MS`, and `NEXUS_USAGE_POLL_INTERVAL_MS` are all read via
  `process.env.X ?? "<default>"` in `apps/agent/src/db/retention.ts`,
  `apps/agent/src/services/tailscale-presence.ts`, and
  `apps/agent/src/services/credential-usage-poller.ts`
- **WHEN** `.env.example` is inspected
- **THEN** all 6 variables have an entry with a comment describing their default and purpose
- **AND** `CREDENTIALS_RETENTION_DAYS`'s comment describes its conditional delete predicate
  (only deletes a row past the window AND with no active lease AND matching
  `status='refresh_failed'` or `is_primary=false`), not a blanket "delete after N days"
- **AND** `NEXUS_PHONE_PEER` and `NEXUS_PRESENCE_USER` remain undocumented (still on plan 022's
  deliberately-deferred list)

### Requirement: Operator-facing comments about environment-variable provenance SHALL be truthful

A code comment or docstring that describes how an environment variable is set (e.g. by a systemd unit, by a deploy script) SHALL accurately reflect the actual mechanism.

#### Scenario: A docstring is corrected to match the real provenance

- **GIVEN** a docstring claiming a systemd unit sets a given environment variable
- **WHEN** the unit file that would set it is inspected and does not set it
- **THEN** the docstring is corrected to describe the variable's actual source (operator
  environment file, process environment, or similar)

