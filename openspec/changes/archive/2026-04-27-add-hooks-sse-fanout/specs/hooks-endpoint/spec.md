# hooks-endpoint Specification (delta)

## ADDED Requirements

### Requirement: Hook events emit to lifecycleBus after persistence

nexus-agent SHALL emit a `HookEventReceived` lifecycle event after each successful `appendSessionEvent` insert in `handleHooks`. The event MUST be emitted on `lifecycleBus` (the singleton in `apps/agent/src/services/lifecycle-bus.ts`) with payload shape `{ eventType: string, sessionId: string, project?: string, eventId: number }`.

The emit MUST happen ONLY when persistence succeeded — i.e. `insertedEventId !== null`. If `appendSessionEvent` throws, the existing fire-and-forget swallow path applies and NO `HookEventReceived` event MAY be emitted (avoid broadcasting an event id that resolves to no row).

The emit MUST NOT block the HTTP response: `lifecycleBus.emit` is synchronous and in-process, but any future async subscribers MUST NOT be awaited.

#### Scenario: Persistence success emits HookEventReceived
- **GIVEN** a payload with `hook_event_name: "session_start"`, `session_id: "abc-123"`, `project: "oo"`
- **WHEN** the handler processes the request
- **AND** `appendSessionEvent` returns event id `42`
- **THEN** `lifecycleBus.emit("HookEventReceived", { eventType: "session_start", sessionId: "abc-123", project: "oo", eventId: 42 })` is called exactly once
- **AND** the HTTP response is HTTP 200 with `{"status": "ok", "event_id": 42}`

#### Scenario: Persistence failure suppresses emit
- **GIVEN** a payload that triggers a DB error inside `appendSessionEvent`
- **WHEN** the handler catches the error and logs it
- **THEN** NO `HookEventReceived` event is emitted on `lifecycleBus`
- **AND** the HTTP response is HTTP 200 with `"persistence error logged"` (existing fire-and-forget behavior preserved)

#### Scenario: Project field is optional
- **GIVEN** a payload missing the `project` field
- **WHEN** the handler persists the event successfully
- **THEN** the emitted `HookEventReceived` payload omits `project` (or sets it to `undefined`)
- **AND** the event still flows to subscribers

### Requirement: SSE stream broadcasts hook events to subscribers

The `GET /events/stream` endpoint SHALL deliver every `HookEventReceived` envelope to every connected subscriber via the existing `lifecycleBus.onAny` wiring in `apps/agent/src/routes/events-sse.ts`. The agent MUST NOT filter events server-side based on subscriber identity, query params, or session scope — filtering is the subscriber's responsibility.

The SSE frame format follows the existing convention used by other lifecycle events:
```
event: HookEventReceived
data: { "event": "HookEventReceived", "payload": { ... }, "source": "local", "seq": N, "ts": "...", "origin": "..." }
```

#### Scenario: Subscriber receives HookEventReceived envelope
- **GIVEN** a client connected to `GET /events/stream`
- **AND** the agent receives a `session_start` hook event that persists successfully
- **WHEN** `lifecycleBus.emit("HookEventReceived", ...)` fires
- **THEN** the client receives an SSE frame with `event: HookEventReceived`
- **AND** the `data:` line parses to a `LifecycleEnvelope` with `event === "HookEventReceived"` and the lean payload

#### Scenario: Server does not filter by subscriber
- **GIVEN** two SSE subscribers — one interested in `session_*` events, one interested in `tool_use_*` events
- **WHEN** any hook event is persisted
- **THEN** both subscribers receive the same `HookEventReceived` envelope
- **AND** each subscriber filters by `payload.eventType` client-side

### Requirement: High-volume hook events are throttled

nexus-agent SHALL coalesce high-frequency `HookEventReceived` emits over a 500ms window per `(eventType, sessionId)` key. Throttled event types include at minimum `tool_use_start` and `tool_use_end`. Other event types (lifecycle, summaries, diagnostics) emit immediately.

Coalesced emits carry `count` (number of suppressed events in the window, ≥1) and the `eventId` of the **last** suppressed event. When `count === 1`, the emit is observationally identical to an immediate emit. When `count > 1`, subscribers know the eventId points to the most recent of N events and can fetch a range if needed.

The throttle window MUST be configurable via an exported constant for tests; production default is 500ms.

#### Scenario: Burst of tool_use_end coalesces to one event per window
- **GIVEN** 20 `tool_use_end` events arrive for `session_id: "abc-123"` within a 200ms span
- **WHEN** the throttle window is 500ms
- **THEN** subscribers receive exactly 1 `HookEventReceived` for that session at the end of the window
- **AND** the payload carries `count: 20` and `eventId` equal to the row id of the 20th event

#### Scenario: Lifecycle events bypass throttle
- **GIVEN** a `session_start` event arrives
- **WHEN** the handler emits `HookEventReceived`
- **THEN** the event reaches subscribers immediately (no 500ms delay)
- **AND** the payload omits `count` (or sets `count: 1`)

#### Scenario: Throttle keys isolate by session
- **GIVEN** `tool_use_end` events for `session_id: "A"` and `session_id: "B"` arrive within the same window
- **WHEN** the throttle coalesces
- **THEN** subscribers receive 2 `HookEventReceived` events — one per session — not a single merged event

### Requirement: Subscriber filtering is client-side

Dashboard pages SHALL implement event-type filtering in the browser. The Next.js SSE proxy at `apps/nextjs/src/app/api/notifications/stream/route.ts` (or a sibling `/api/hooks/stream` if added) MUST forward all envelopes; per-page subscribers MUST inspect `payload.eventType` and `payload.sessionId` / `payload.project` to decide whether to refetch.

This requirement codifies the architecture decision: server stateless re: subscriber interest. New dashboard surfaces add no agent-side code.

#### Scenario: Session detail page filters by sessionId
- **GIVEN** the user is viewing `/session/abc-123`
- **AND** the page subscribes to `HookEventReceived`
- **WHEN** an event arrives with `payload.sessionId === "other-session"`
- **THEN** the page ignores it (no refetch)
- **WHEN** an event arrives with `payload.sessionId === "abc-123"`
- **THEN** the page refetches `/sessions/abc-123` (or the session-events query) and re-renders

#### Scenario: Project page filters by project
- **GIVEN** the user is viewing `/projects/oo`
- **WHEN** an event arrives with `payload.project === "tl"`
- **THEN** the page ignores it
- **WHEN** an event arrives with `payload.project === "oo"`
- **THEN** the page refetches the project's session list and updates the badge counts
