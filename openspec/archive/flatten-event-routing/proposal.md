# Proposal: Flatten Event Routing — Remove socket-dispatch Intermediary

## Change ID
`flatten-event-routing`

## Summary
Eliminate the socket-dispatch intermediary layer so socket events emit directly to the lifecycle bus, reducing the event chain from 3 hops to 2 and removing one dedup boundary.

## Context
- Extends: `apps/agent/src/services/socket-server.ts`, `apps/agent/src/services/lifecycle-bus.ts`, `apps/agent/src/services/socket-dispatch.ts`
- Related: Architecture review (2026-04-09) finding 4

## Motivation
Events currently traverse: socket-server → socket-dispatch → lifecycle-bus → consumers. The socket-dispatch layer was created during Wave 1 as a translation layer between socket event types and lifecycle bus events. Now that both use the same typed events, the dispatch layer is redundant — it adds 214 LOC, one extra dedup boundary, and makes the event flow harder to trace. The socket server should emit directly to the lifecycle bus. Consumers (WebSocket, SSE, federation, notifications) already subscribe to the bus.

## Requirements

### Req-1: Direct socket-to-bus emission
Move the event translation logic (SessionStart → lifecycleBus.emit("SessionStarted"), etc.) from socket-dispatch.ts into socket-server.ts's event handler. The socket server becomes the first and only hop before the bus.

### Req-2: Remove socket-dispatch.ts
Delete `apps/agent/src/services/socket-dispatch.ts` and its test file. Update all imports in index.ts and server.ts.

### Req-3: Preserve notification recording
socket-dispatch.ts currently calls `recordNotification()` for Notification events. This logic moves into the socket server's event handler or a lightweight inline function.

## Scope
- **IN**: socket-dispatch removal, socket-server event handler update, import cleanup
- **OUT**: Changing the lifecycle bus API, modifying federation or notification routing, adding new event types

## Impact
| Area | Change |
|------|--------|
| `apps/agent/src/services/socket-server.ts` | Absorbs dispatch logic (~40 LOC from socket-dispatch) |
| `apps/agent/src/services/socket-dispatch.ts` | Deleted (214 LOC) |
| `apps/agent/src/index.ts` | Remove socket-dispatch import and wiring |
| Net | -170 LOC, 1 fewer dedup boundary |

## Risks
| Risk | Mitigation |
|------|-----------|
| Missing a dispatch path during merge | Diff socket-dispatch.ts line-by-line, verify every case is handled |
| Breaking existing socket-dispatch tests | Port relevant test cases to socket-server.test.ts |
