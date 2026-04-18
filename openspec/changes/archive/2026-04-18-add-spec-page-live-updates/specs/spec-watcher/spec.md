# spec-watcher Delta

## ADDED Requirements

### Requirement: The system MUST detect openspec writes via filesystem watching
The spec-watcher service MUST establish a filesystem watch on each registered project's `openspec/changes/` directory (shallow, non-recursive) and trigger a targeted re-poll of the affected change within 1 second of any write event. The watch MUST coexist with the existing 60-second poll; polling is retained as a safety net for missed events.

#### Scenario: tasks.md checkbox tick triggers targeted re-poll
- **Given** project "oo" is registered and its `openspec/changes/add-user-auth/tasks.md` is being watched
- **When** a user ticks a checkbox in `tasks.md` and saves
- **Then** the spec-watcher re-polls only `add-user-auth` within 1 second and emits a progress transition if `completedTasks` increased

#### Scenario: new proposal directory appears
- **Given** project "oo" is registered with 2 tracked specs
- **When** a new directory `openspec/changes/new-feature/` appears on disk
- **Then** the spec-watcher detects the directory-create event and emits a "new spec" transition within 1 second

#### Scenario: inotify watch limit hit
- **Given** the agent has already established watches for 20 projects
- **When** adding a new watch returns `ENOSPC`
- **Then** the service logs a warning, records the project as degraded, and continues serving that project with 60-second poll only

#### Scenario: debounce collapses burst of writes
- **Given** a single spec receives 5 write events within 250 ms (e.g., `bd sync` updating `tasks.md` multiple times)
- **When** the debounce window (300 ms) elapses
- **Then** the spec-watcher performs exactly one targeted re-poll for that spec

---

### Requirement: The system MUST expose spec transitions as a Server-Sent Events stream
The agent MUST expose `GET /specs/events` as an SSE endpoint. When the spec-watcher emits a `SpecTransition` to `lifecycleBus`, the SSE handler MUST forward a corresponding event to all connected clients. Events MUST be coalesced in a 5-second window to avoid spamming clients during bursts.

#### Scenario: client receives transition within the coalescing window
- **Given** a browser is subscribed to `/specs/events` via EventSource
- **When** the spec-watcher emits a progress transition for spec `add-user-auth` in project `oo`
- **Then** the client receives a message of type `progress` with payload `{ project: "oo", spec: "add-user-auth", completedTasks, totalTasks }` within 5 seconds

#### Scenario: multiple transitions coalesce
- **Given** 3 specs transition within 2 seconds across 2 projects
- **When** the 5-second coalescing window elapses
- **Then** the SSE stream emits a batched message containing all 3 transitions, not 3 separate messages

#### Scenario: SSE stream survives disconnect
- **Given** a client's EventSource connection drops
- **When** the client reconnects
- **Then** the agent accepts the new connection without error (stream is stateless; recovery of missed events is the client's responsibility via refetch)
