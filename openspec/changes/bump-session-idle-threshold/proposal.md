# Proposal: Bump session-manager idle threshold from 5m to 60m

## Change ID
`bump-session-idle-threshold`

## Phase
P1 consolidation (parent: spine-migration · nx-ma6h8 · feature: nx-248sw)

## Summary
Update `IDLE_THRESHOLD_MS` in `apps/agent/src/session-manager.ts` to 60 minutes to align with Claude Code's current session cache TTL.

## Context
- Modifies: `apps/agent/src/session-manager.ts` (one constant)
- Related: `SWEEP_INTERVAL_MS` (currently 60s) — review if it needs adjustment
- Tests: `apps/agent/src/session-manager.test.ts` (timing assertions)

## Motivation
The 5-minute idle threshold was tied to a legacy CC session cache. CC updated its session cache TTL to 60 minutes. Our 5m threshold now produces noisy "idle" transitions every coffee break, contradicting CC's own state. False-positive idle events spam the SSE bus and produce misleading "idle" badges in the TUI.

## Requirements

### Requirement: idle threshold SHALL be 60 minutes

`IDLE_THRESHOLD_MS` in `session-manager.ts` SHALL equal `60 * 60 * 1000` (3,600,000 ms). The stale and evict thresholds SHALL shift proportionally to preserve the active → idle → stale → evict cadence.

#### Scenario: session with 30-minute gap stays active
- **GIVEN** the new threshold
- **WHEN** a session emits a heartbeat at t=0 and the next heartbeat arrives at t=30min
- **THEN** the session remains `active` (was previously `idle` at t=5min)
