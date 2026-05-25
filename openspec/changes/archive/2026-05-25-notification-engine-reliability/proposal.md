# notification-engine-reliability

## Why

The agent notification engine has four reliability gaps: the meeting state machine lacks transition guards (invalid transitions are silently accepted); the notification buffer has no overflow protection (unbounded growth under load); external channel API awaits in `router.ts` have no timeout (a hung channel stalls all delivery); and the routing handler silently skips a missing channel handler (delivery is lost with no signal). Each gap turns a recoverable condition into silent data loss or a stalled pipeline.

## What Changes

- Add explicit transition guards to the meeting state machine so invalid transitions are rejected and logged instead of silently accepted.
- Bound the notification buffer with an overflow policy (max size + drop/evict on overflow).
- Wrap external channel API awaits in `router.ts` with timeouts so a hung channel cannot stall delivery.
- Make the routing handler surface (log + capture) a missing channel handler instead of silently skipping it.

## Context

- touches: `apps/agent/src/notifications/router.ts`, `apps/agent/src/notifications/manager.ts`, `apps/agent/src/notifications/meeting-state.ts`, `apps/agent/src/notifications/buffer.ts`

## Non-Goals

- Adding new notification channels or rewriting the dispatcher bus.
- Changing the socket protocol or hook-ingest contract.
- Persisting buffered notifications across agent restarts.
