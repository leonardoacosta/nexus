# Proposal: Drop RECOGNIZED_EVENTS allow-list — accept any hook payload

## Change ID
`drop-recognized-events-allowlist`

## Phase
P2 cc-integration (parent: spine-migration · nx-ma6h8 · feature: nx-uptrm)

## Summary
Stop filtering hook events against a hardcoded `RECOGNIZED_EVENTS` set in `routes/hooks.ts`. Persist the full raw payload always; let the drift detector (P2.1) catch new shapes.

## Context
- Modifies: `apps/agent/src/routes/hooks.ts` (drop RECOGNIZED_EVENTS check)
- Modifies: `packages/db/src/schema/sessionEvents.ts` (metadata column stores entire payload — likely no change, just behavior shift)
- Depends-on: `add-schema-drift-detector` (P2.1 · nx-q9wv4) — drift detector replaces the silent-drop behavior

## Motivation
The current allow-list silently drops new CC event types. CC's recent additions (`SubagentStart`, `SubagentStop`, `TaskCompleted`, `TeammateIdle`) would have been invisible until someone updated the constant. Replacing the allow-list with the drift detector means CC additions surface automatically as `HookSchemaDrift` events.

## Requirements

### Requirement: ALL hook event types SHALL be accepted

The dispatcher SHALL NOT reject any hook payload based on event type. Unknown types persist to `session_events` with their full payload.

### Requirement: full raw payload SHALL be stored

`session_events.metadata` SHALL contain `JSON.stringify(payload)` — the entire body as received, not a filtered subset.

#### Scenario: new event type arrives
- **GIVEN** CC starts sending event_type `WorkspaceChanged` (not in any allow-list)
- **WHEN** the payload arrives
- **THEN** a session_events row is created with the full payload AND P2.1 fires HookSchemaDrift
