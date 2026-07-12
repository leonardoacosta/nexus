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

### Requirement: Operator-facing comments about environment-variable provenance SHALL be truthful

A code comment or docstring that describes how an environment variable is set (e.g. by a systemd unit, by a deploy script) SHALL accurately reflect the actual mechanism.

#### Scenario: A docstring is corrected to match the real provenance

- **GIVEN** a docstring claiming a systemd unit sets a given environment variable
- **WHEN** the unit file that would set it is inspected and does not set it
- **THEN** the docstring is corrected to describe the variable's actual source (operator
  environment file, process environment, or similar)
