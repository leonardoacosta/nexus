---
order: 0724f
---

# Proposal: Delete the Duplicate "socket: notification" INFO Log in the Dispatcher

## Change ID
`dedupe-dispatcher-notification-log`

> Advisor stamp: 2026-07-24 `/improve` run against commit `9e4963b9`. Verify cited lines before starting; STOP on drift.

## Summary
`apps/agent/src/services/socket-server/dispatcher.ts` emits the identical structured INFO line (`"socket: notification"`, same fields) twice for every delivered notification: once unconditionally at case entry (~:283) and again inside the `deliver()` closure (~:316), which runs synchronously on the common non-rate-limit path (~:357). The outer log predates the reactive-swap extraction that introduced `deliver()` and was never removed. Delete the outer one; keep the one inside `deliver()` since it also covers the deferred rate-limit path.

## Context
- depends on:
- touches: `apps/agent/src/services/socket-server/dispatcher.ts`

## Motivation
Found by the 2026-07-24 advisor audit (tech-debt, HIGH confidence — dead code left by `wire-reactive-rate-limit-swap`). Doubled log volume on the notification hot path in an already info-heavy dispatcher; pure noise, no behavioral effect.

## Testing
- `bun test apps/agent/src/services/socket-server` green (confirms no test asserts on double emission).
- `grep -c '"socket: notification"' apps/agent/src/services/socket-server/dispatcher.ts` returns exactly 1.

## Done Means
- One INFO line per delivered notification in the agent log, on both the immediate and deferred (rate-limit) delivery paths.
- No other log lines touched.

## Scope
- **IN**: deleting the outer `log.info` block at ~:283-292.
- **OUT**: `deliver()` logic, any other dispatcher case, log levels/fields elsewhere.
