# Implementation Tasks

<!-- beads:epic:nx-9ftj -->

## API Batch

- [ ] [1.1] [P-1] Create `apps/agent/src/services/socket-server.ts`: Bun.listen({ unix: '/tmp/nexus-agent.sock' }) with NDJSON parser, event type discriminator, and connection lifecycle management [owner:api-engineer]
- [ ] [1.2] [P-1] Define TypeScript types for all socket event types (SessionStart, SessionStop, SessionHeartbeat, Notification, Answer, AgentSpawn, AgentComplete, Telemetry, SessionSummary, DeployStatus) and command types (ModeQuery, ModeSet, ModeCycle, History, TypeSet, TypeClear, NotificationRules, NotificationSet) matching the Rust `SocketEvent` enum [owner:api-engineer]
- [ ] [1.3] [P-2] Wire socket SessionStart/SessionStop/SessionHeartbeat events into existing `SessionManager` — route through the same `handleEvent()` path as watcher events [owner:api-engineer]
- [ ] [1.4] [P-2] Wire socket Notification events into existing notification router (`apps/agent/src/notifications/router.ts`) for TTS/desktop/iMessage delivery [owner:api-engineer]
- [ ] [1.5] [P-2] Wire socket command types (ModeQuery/ModeSet/ModeCycle etc.) into a new `CommandHandler` that reads/writes notification mode state [owner:api-engineer]
- [ ] [1.6] [P-1] Create `apps/agent/src/services/cron.ts`: two scheduled jobs — `maintain` (daily 00:17, prune temp/logs/cache/sessions) and `drift` (weekly Sun 09:00, validate settings.json, check orphaned worktrees) using setInterval with absolute next-run timestamps [owner:api-engineer]
- [ ] [1.7] [P-1] Create `apps/agent/src/services/spec-watcher.ts`: 60s polling loop, batches of 4 projects with 200ms delay, runs `Bun.spawn('openspec', ['list', '--json'])` per project with 5s timeout, detects NewSpec/Removed/Progress/AllComplete/HashChanged transitions, fires TTS via notification router [owner:api-engineer]
- [ ] [1.8] [P-3] Register socket server, cron service, and spec watcher in `apps/agent/src/server.ts` startup — start after HTTP server is listening, shut down gracefully on SIGTERM [owner:api-engineer]

## E2E Batch

- [ ] [2.1] Write integration tests: send NDJSON events to `/tmp/nexus-agent.sock` via `Bun.connect({ unix })`, verify SessionManager receives them and updates state correctly [owner:e2e-engineer]
- [ ] [2.2] Write unit tests for cron next-run calculation logic (daily and weekly schedules, timezone edge cases) [owner:e2e-engineer]
- [ ] [2.3] Write unit tests for spec watcher transition detection (NewSpec, Removed, Progress, AllComplete, HashChanged) with mock subprocess output [owner:e2e-engineer]
- [ ] [2.4] Integration test: verify CC hook writers (nexus-register, nova) can write to socket and Bun agent processes events — run `echo '{"event":"session_start",...}' | socat - UNIX-CONNECT:/tmp/nexus-agent.sock` and check session appears [owner:e2e-engineer]
