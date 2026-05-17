---
status: approved
approved-by: leo@leonardoacosta.dev
approved-at: 2026-05-17T20:26:38Z
---

# Proposal: cc-credential-manager — actively manage credentials.json

## Change ID
`add-cc-credential-manager`

## Phase
P4 apple-ecosystem (parent: spine-migration · nx-ma6h8 · feature: nx-tsjwq)

## Summary
Wrap CC's credentials.json. Track OAuth profile expiry, refresh proactively, swap on rate-limit. New cc_profiles table with encrypted refresh tokens, expiry, cost-per-profile.

## Context
- Adds: `apps/agent/src/cc-credential-manager.ts` (full impl, replacing P1.2 placeholder)
- Adds: `packages/db/src/schema/ccProfiles.ts`
- Renames: `packages/db/src/schema/credentialEvents.ts` -> `ccProfileEvents.ts`
- Modifies: CC's credentials.json (the agent owns writes — backup before first write)
- Risk: brittle to CC auth format changes — emit CCAuthSchemaDrift on diff

## Motivation
Active management enables proactive token refresh before expiry, automatic profile swap on rate-limit, cost attribution per profile across sessions. You confirmed (round 2): manage directly, not observe-only.

## Requirements

### Requirement: cc_profiles SHALL track every observed Claude profile

Columns: id (PK), type ('pro' | 'max' | 'api_key'), oauth_refresh_token (encrypted), expiry_ts, last_used_ts, current_cost_usd, rate_limit_status.

### Requirement: agent SHALL refresh tokens proactively

When expiry_ts is within 5 minutes, the manager calls CC's OAuth refresh endpoint, updates credentials.json, emits CCProfileRefreshed.

### Requirement: agent SHALL swap profiles on rate-limit

On 429: select next eligible profile, write to credentials.json. Per your observation, CC re-reads automatically — no session restart needed.

### Requirement: schema drift SHALL be detected and surfaced

Fingerprint credentials.json schema. On format diff, emit CCAuthSchemaDrift and fall back to passive-observe until supported.

#### Scenario: rate-limit triggers swap
- **WHEN** the manager detects 429
- **THEN** new profile is written to credentials.json within 100ms; CC's next call uses it
