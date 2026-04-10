# Implementation Tasks

<!-- beads:epic:nx-x2fx -->

## API Batch

- [x] [1.1] [P-1] Move event translation logic from socket-dispatch.ts into socket-server.ts: for each socket event type (SessionStart, SessionStop, SessionHeartbeat, Notification, AgentSpawn, AgentComplete, Telemetry, SessionSummary, DeployStatus), emit directly to lifecycleBus from the socket server's onEvent handler [owner:api-engineer]
- [x] [1.2] [P-1] Move notification recording from socket-dispatch into socket-server: the `recordNotification()` call for Notification events and the history ring buffer integration [owner:api-engineer]
- [x] [1.3] [P-2] Delete `apps/agent/src/services/socket-dispatch.ts` and update all imports: remove from index.ts, server.ts, and any other files that reference createSocketEventHandler [owner:api-engineer]
- [x] [1.4] [P-2] Update `apps/agent/src/index.ts`: remove socket-dispatch import, pass lifecycleBus directly to socket server configuration instead of the dispatch handler [owner:api-engineer]

## E2E Batch

- [x] [2.1] Port socket-dispatch.test.ts test cases to socket-server.test.ts: verify that socket events (session_start, session_stop, heartbeat, notification) are emitted to the lifecycle bus directly from the socket server [owner:e2e-engineer]
- [x] [2.2] Delete `apps/agent/src/services/socket-dispatch.test.ts` after tests are ported [owner:e2e-engineer]
