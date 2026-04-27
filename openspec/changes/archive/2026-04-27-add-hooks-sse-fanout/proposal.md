---
status: approved
approved-by: leo@leonardoacosta.dev
approved-at: 2026-04-27T02:53:42-05:00
---
# Proposal: add-hooks-sse-fanout

## Change ID
`add-hooks-sse-fanout`

## Summary
Re-emit persisted hook events to `/events/stream` so the Next.js dashboard updates live without polling. After `handleHooks` writes to `session_events`, emit a lean `HookEventReceived` lifecycle event carrying `{event_type, session_id, project, event_id}`. Existing subscribers wired through `lifecycleBus.onAny` (in `apps/agent/src/routes/events-sse.ts`) flow the event to dashboard pages, which filter client-side and refetch the full row from `/sessions/:id` or `/sessions?project=X`.

## Context
- **Affects**: `apps/agent/src/routes/hooks.ts` (emit point), `apps/agent/src/services/lifecycle-bus.ts` (new event), `apps/agent/src/routes/events-sse.ts` (already streams `lifecycleBus.onAny`, no endpoint change needed), `apps/nextjs/src/app/session/[id]/page.tsx`, `apps/nextjs/src/app/projects/[name]/page.tsx`.
- **Capabilities**: extends `hooks-endpoint`.
- **Predecessor**: `restore-hooks-event-persistence` (commit 436fb37, archived 2026-04-27) — restored the `appendSessionEvent` write path that this proposal now broadcasts.
- **Soft dependency**: `extend-hooks-event-taxonomy` (`nx-h8uxs`). This proposal is **independently valid**: it broadcasts whatever event types `handleHooks` already recognizes (`session_start`, `session_stop`, `stop_failure`, `stop_success`, `session_summary`, `session_heartbeat`, `diagnostic_ping`). New types added by `extend-hooks-event-taxonomy` join the broadcast automatically because the emit happens after persistence regardless of `event_type` value. Land in either order; neither blocks the other.
- **Sibling**: `nx-6irva` (notification triggers, independent).

## Motivation

### Current state

`/events/stream` broadcasts these lifecycle events today: `SessionStarted`, `SessionStopped`, `SessionHeartbeat`, `StatusChanged`, `SpecTransition`, `CredentialSwap`, `CredentialDecryptFallback`, `NotificationFired`, `SettingsChanged`. Hook events that landed in `session_events` (the persistent log) are **not** on the bus, so dashboards must poll `/sessions` or `/failures` to discover new activity.

### Why it matters

- **Session detail page**: `/session/[id]` cannot live-append a session timeline (tool_use, prompts, sub-agent spawns) because those events never reach the browser via SSE.
- **Project detail page**: `/projects/[name]` cannot update session-count or last-activity badges without a polling loop.
- **Dashboard root**: Already subscribes to `NotificationFired` for live banners, but session activity stays cold.

The persistence layer is in place (post-`restore-hooks-event-persistence`); the missing piece is the bus emit + a thin client subscription.

### Why lean payload

A fat-event broadcast (full `session_events` row + joined metadata) on a high-frequency stream (tool_use_end can fire dozens of times per minute on tight loops) wastes bandwidth and forces the agent to compute fields no subscriber may need. The lean payload `{event_type, session_id, project, event_id}` is enough for any subscriber to decide whether to refetch — and lets each consumer fetch only the shape it actually needs.

## What Changes

### New lifecycle event: `HookEventReceived`

Add to `LifecycleEventMap` in `apps/agent/src/services/lifecycle-bus.ts`:

```ts
export interface HookEventReceivedPayload {
  /** Hook event type (e.g. "session_start", "tool_use_end"). */
  eventType: string;
  /** Session id the event belongs to. */
  sessionId: string;
  /** Optional project scope for client-side filtering. */
  project?: string;
  /** Row id returned by appendSessionEvent — lets clients fetch the full row. */
  eventId: number;
}
```

### Emit from `handleHooks`

In `apps/agent/src/routes/hooks.ts`, after `appendSessionEvent` succeeds (line ~241–246) and after the lifecycle side-effects switch, emit `HookEventReceived` with the lean payload. The emit happens **only when** `insertedEventId !== null` — if persistence fails we already swallow + log, and we MUST NOT broadcast a stale event id that doesn't resolve to a row.

### High-volume throttle

`tool_use_start` and `tool_use_end` can fire at high frequency during agent work. Introduce a small throttle helper (`apps/agent/src/services/hook-event-throttle.ts`) that:
- Buffers throttled event types per `(eventType, sessionId)` key on a 500ms window.
- Coalesces buffered events into a single `HookEventReceived` carrying `count` (number of suppressed events in the window) and the **last** `eventId`.
- Other event types emit immediately (no throttle).

Throttle window and event-type set are constants exported for tests.

### Client-side filtering convention

Server broadcasts ALL hook events to all subscribers — no server-side per-connection filter. Each dashboard page subscribes via `EventSource` (or wraps the existing `spec-events-transport.ts` pattern) and filters by `event_type` / `project` / `session_id` in the browser. Keeps the agent stateless about subscriber interest.

### Backpressure

Preserve existing per-connection behavior in `events-sse.ts`: slow consumers are dropped by the underlying ReadableStream's `enqueue` failure path. The 500ms coalesce reduces the most common high-volume case; pathological floods still rely on existing backpressure.

## Impact

### Behavior change

| Surface | Before | After |
|---|---|---|
| `/events/stream` events emitted | 9 lifecycle event types | 10 (adds `HookEventReceived`) |
| Dashboard refresh model | Manual poll / page reload | Live append on `HookEventReceived` |
| Bandwidth on tool_use floods | N/A (no broadcast) | ≤2 events/sec/session (500ms coalesce) |
| Latency added to `handleHooks` | 0 | ~0.1ms (`emitter.emit` is sync, in-process) |

### Schema

No schema changes. The `event_id` returned by `appendSessionEvent` is the existing `session_events.id` column.

### Trade-offs accepted

| Trade-off | Decision rationale |
|---|---|
| Server broadcasts to all, clients filter | Stateless server; trivial to add new dashboard pages |
| Lean payload requires follow-up fetch | Avoids fat events on high-frequency stream |
| 500ms throttle adds bounded staleness for `tool_use_*` | Bandwidth saving > sub-second tool tick freshness |
| No new endpoint | Reuses `lifecycleBus.onAny` wiring — zero new auth/CORS surface |
| Independent of taxonomy extension | This proposal is useful day-1 with current event types; new types join automatically |
