# Proposal: AF_UNIX socket dispatcher reaches feature parity with /hooks

## Change ID
`socket-dispatcher-parity`

## Phase
P3 ingress-collapse (parent: spine-migration · nx-ma6h8 · feature: nx-onmun)

## Summary
Audit `services/socket-server/dispatcher.ts` against `routes/hooks.ts` and add any missing handling so the socket path can fully replace the HTTP path.

## Context
- Modifies: `apps/agent/src/services/socket-server/dispatcher.ts`
- Reference: `apps/agent/src/routes/hooks.ts` (the parity target)
- Blocks: `add-socket-hook-helper` (P3.2 · nx-0lgey), `migrate-cc-hooks-to-socket` (P3.3 · nx-24yyq), `delete-http-hooks-endpoint` (P3.4 · nx-pef3t)

## Motivation
Today both paths feed the same `handleWatcherEvent` dispatcher, but `routes/hooks.ts` does additional wrapping: credentialFingerprint binding, throttle layer integration, schema-drift detector hook (P2.1), git-project resolver hook (P2.2). The socket dispatcher needs all of this before we can delete the HTTP path.

## Requirements

### Requirement: socket dispatcher SHALL handle every hook event type identically to /hooks

For every hook event_type, the socket path SHALL produce the same `session_events` row, the same lifecycle bus emit, the same throttle behavior, the same enrichment (git-project, drift detector) as the HTTP path. A parity test SHALL assert this for all known event types.

#### Scenario: same payload, same outcome
- **GIVEN** an identical payload P
- **WHEN** P is sent via both POST /hooks and AF_UNIX socket
- **THEN** both produce byte-identical `session_events.metadata` rows and identical lifecycle envelope sequences
