# harden-notification-reliability — Change Proposal

## Summary

Four-finding bundle that hardens notification reliability: buffer overflow cap + LRU eviction (already implemented — spec delta only), meeting-state transition guards (already implemented using `InvalidStateError` — spec delta only), timeout on external API awaits, and warn + Sentry breadcrumb on missing channel handler. Closes nx-s0sg, nx-zncj, nx-x39j, nx-y035.

## Motivation

Unbounded buffer growth is a latent OOM. Missing meeting guards mean call-sites silently succeed when they should error (caller can double-start a meeting). Missing timeouts mean a single flaky webhook blocks the entire notification engine indefinitely. Silent skip of unknown channel loses user notifications invisibly. Four small fixes, one cohesive reliability scope.

**Source-file audit findings (verified):**

- `buffer.ts`: `MAX_BUFFER_SIZE = 1000` and FIFO eviction via `pendingIds.shift()` are already implemented at lines 12 and 77–80. Spec delta required; no code change needed.
- `meeting-state.ts`: Guards are already implemented. `start()` throws `InvalidStateError` when `_inMeeting` is true; `end()` throws when `_inMeeting` is false. Error class is `InvalidStateError` (not `InvalidTransition`). Spec delta required; no code change needed.
- `router.ts`: `routeNotification()` (serial) emits `log.warn` on unknown channel but no Sentry breadcrumb. `routeNotificationParallel()` similarly emits `log.warn` only. Neither function has a timeout around the channel handler awaits. **Code changes required** for nx-x39j and nx-y035.

## Requirements (ADDED)

### Bounded notification buffer
The notification buffer MUST enforce a maximum size (1000 entries default); at cap, oldest entries SHALL be evicted (FIFO — implemented via `pendingIds.shift()`). The implementation already satisfies this requirement; this entry captures it in the spec.

### Meeting state transition guards
`start()` MUST throw `InvalidStateError` if already in a meeting; `end()` MUST throw `InvalidStateError` if not in a meeting; `start()` after `end()` MUST succeed. The implementation already satisfies this requirement using `InvalidStateError` (not `InvalidTransition`); this entry captures it in the spec.

### Timeout on external notification delivery
Every external API call in the notification delivery path MUST have a timeout (default 10s, configurable via `NEXUS_NOTIFICATION_TIMEOUT_MS` env var). Exceeding the timeout MUST emit a Sentry `captureException` and return a structured failure, not hang. Applies to both `routeNotification()` and `routeNotificationParallel()` in `router.ts`.

### Observable missing-handler routing
If a notification specifies a channel for which no handler is registered, the routing layer MUST emit a WARN log AND a Sentry breadcrumb naming the missing channel before dropping the notification. The current code emits only the WARN log; a `Sentry.addBreadcrumb` call is missing in both routing paths.

## Scope

**IN:** 4 fixes above (2 spec-only, 2 code + spec).

**OUT:** New notification channels, changes to delivery semantics for existing successful paths, refactoring the notification engine structure.

## Impact

- `apps/agent/src/notifications/buffer.ts` — spec delta only (code already satisfies)
- `apps/agent/src/notifications/meeting-state.ts` — spec delta only (code already satisfies; error class is `InvalidStateError`)
- `apps/agent/src/notifications/router.ts` — add `Promise.race` timeout wrapper around channel handler invocations; add `Sentry.addBreadcrumb` calls alongside existing `log.warn` on unknown channel
- Tests for nx-x39j and nx-y035 (see tasks.md E2E batch)

## Risks

- **Buffer eviction policy**: FIFO is already implemented and documented in code. No change needed.
- **Meeting guards break existing callers**: Audit shows `routes/notifications.ts:180` calls `manager.startMeeting()` which delegates to `meetingState.start()`. Guards are already live; existing callers operate correctly under the current implementation.
- **Timeout value wrong**: Make timeout configurable via `NEXUS_NOTIFICATION_TIMEOUT_MS` env var with 10s default. Document in code.
- **`InvalidStateError` vs `InvalidTransition`**: The existing implementation uses `InvalidStateError`. The spec and tasks use this name consistently — the issue brief referenced `InvalidTransition` but the actual class is `InvalidStateError`.
