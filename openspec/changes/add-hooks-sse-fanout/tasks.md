# Implementation Tasks

<!-- beads:epic:nx-u2m9a -->
<!-- beads:feature:nx-mfarp -->

> Beads filed via `beads:spec-sync --append` once Leo approves the proposal. Existing capability epic (`nx-u2m9a`) and feature (`nx-mfarp`) are reused — no new epic/feature beads.

## DB Batch

(none — no schema migrations required; the `event_id` returned by `appendSessionEvent` already exists as `session_events.id`)

## API Batch

- [x] [1.1] [P-1] Add `HookEventReceived` to `LifecycleEventMap` in `apps/agent/src/services/lifecycle-bus.ts` with payload `{ eventType: string, sessionId: string, project?: string, eventId: number, count?: number }`. Export the payload interface as `HookEventReceivedPayload` [owner:api-engineer] [type:code] [beads:nx-v9tys]
- [x] [1.2] [P-1] Emit `HookEventReceived` from `handleHooks` in `apps/agent/src/routes/hooks.ts` after `appendSessionEvent` succeeds — guarded on `insertedEventId !== null`. Place the emit AFTER the lifecycle side-effects switch but BEFORE the success response so any sync subscribers run in the same tick [owner:api-engineer] [type:code] [beads:nx-eyyxq]
- [x] [1.3] [P-1] Create `apps/agent/src/services/hook-event-throttle.ts`: a coalescing buffer keyed by `(eventType, sessionId)` with a 500ms window. Throttled types: `tool_use_start`, `tool_use_end`. Export `THROTTLE_WINDOW_MS` and `THROTTLED_EVENT_TYPES` constants [owner:api-engineer] [type:code] [beads:nx-bhki6]
- [x] [1.4] [P-1] Wire the throttle helper into `handleHooks` so `HookEventReceived` for throttled event types flows through the buffer. Non-throttled types call `lifecycleBus.emit` directly [owner:api-engineer] [type:code] [beads:nx-2cv80]
- [x] [1.5] [P-1] Unit test the throttle helper in `apps/agent/src/services/hook-event-throttle.test.ts`: bursts coalesce, per-session keys isolate, single events pass through, window expiry flushes pending buffer [owner:api-engineer] [type:testing] [beads:nx-6wabv]
- [x] [1.6] [P-1] Add lifecycle-bus integration tests in `apps/agent/src/routes/hooks.test.ts`: persistence success emits with correct payload, persistence failure suppresses emit, lifecycle events bypass throttle [owner:api-engineer] [type:testing] [beads:nx-7pitp]
- [x] [1.7] [P-2] Verify `apps/agent/src/routes/events-sse.ts` already forwards `HookEventReceived` via `lifecycleBus.onAny` — add a one-line comment in `events-sse.ts` documenting that hook events are now part of the broadcast set; no code change [owner:api-engineer] [type:docs] [beads:nx-d7x48]
- [x] [1.8] [P-2] SSE round-trip test in `apps/agent/src/routes/events-sse.test.ts` (or extend existing test): connect to `/events/stream`, emit a `HookEventReceived`, assert frame received with correct `event:` line and JSON payload [owner:api-engineer] [type:testing] [beads:nx-qxpaq]

## UI Batch

- [x] [2.1] [P-1] Update `apps/nextjs/src/app/session/[id]/page.tsx` to subscribe to `HookEventReceived` events from `/events/stream` (via `apps/nextjs/src/app/api/notifications/stream/route.ts` proxy). On match (`payload.sessionId === id`), trigger a refetch of session-events for live timeline append [owner:ui-engineer] [type:code] [beads:nx-xuhhj]
- [x] [2.2] [P-1] Update `apps/nextjs/src/app/projects/[name]/page.tsx` to subscribe and on match (`payload.project === decodedName`), refetch the project session list to update session-count and last-activity badges [owner:ui-engineer] [type:code] [beads:nx-z6my1]
- [x] [2.3] [P-1] Extract a shared client-side filter helper at `apps/nextjs/src/lib/hooks/use-hook-events.ts` modelled on `apps/nextjs/src/app/specs/spec-events-transport.ts`. Accepts a predicate `(envelope) => boolean` and a callback. Reuses `EventSource` reconnect/backoff [owner:ui-engineer] [type:code] [beads:nx-0auq3]
- [x] [2.4] [P-1] Unit test the client-side filter in `apps/nextjs/src/lib/hooks/use-hook-events.test.tsx`: filter predicate matches/skips correctly, EventSource reconnect fires re-fetch, unsubscribe on unmount [owner:ui-engineer] [type:testing] [beads:nx-l5xm9]
- [x] [2.5] [P-2] Smoke test for both pages in `apps/nextjs/src/app/session/[id]/page.test.tsx` and `apps/nextjs/src/app/projects/[name]/page.test.tsx`: render with a stub EventSource, dispatch a `HookEventReceived` frame, assert refetch was called [owner:ui-engineer] [type:testing] [beads:nx-pof1e]

## E2E Batch

- [x] [3.1] [P-1] Browser E2E in `apps/nextjs/tests/e2e/hooks-sse-fanout.spec.ts`: open `/session/<id>` against deployed dev environment, POST a `tool_use_end` to the agent's `/hooks`, assert the page DOM updates within 1s without a manual reload. Use `[data-testid]` on the timeline list [owner:e2e-engineer] [type:testing] [beads:nx-u682w]
- [x] [3.2] [P-2] Throttle observation E2E in `apps/nextjs/tests/e2e/hooks-sse-fanout-throttle.spec.ts`: POST 30 `tool_use_end` events in a 200ms burst, observe network tab via Playwright instrumentation, assert ≤2 SSE frames arrive within the window [owner:e2e-engineer] [type:testing] [beads:nx-b3l7s]
- [ ] [3.3] [P-3] [user] After deploy, open `/projects/oo` in a browser, run a real `/apply` invocation in the `oo` repo, confirm the session-count badge increments without a page refresh [owner:user] [type:testing] [beads:nx-taxye]
