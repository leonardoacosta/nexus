## 1. Core Types
- [x] [1.1] Define Session interface in packages/core (id, project, machine, status, started_at, last_activity, pid, cwd) [owner:engineer]
- [x] [1.2] Define SessionStatus union type: "active" | "idle" | "ended" [owner:engineer]
- [x] [1.3] Define IPC message types for watcher events (session_start, session_update, session_end) [owner:engineer]

## 2. IPC Subprocess Manager
- [x] [2.1] Implement watcher subprocess spawner using Bun.spawn with stdin/stdout JSON IPC [owner:engineer]
- [x] [2.2] Parse newline-delimited JSON from watcher stdout into typed IPC events [owner:engineer]
- [x] [2.3] Send control messages (watch, shutdown) to watcher via stdin [owner:engineer]
- [x] [2.4] Handle watcher crash detection and automatic restart with exponential backoff [owner:engineer]

## 3. Session State Machine
- [x] [3.1] Implement in-memory session store (Map<string, Session>) with insert/update/query [owner:engineer]
- [x] [3.2] Map IPC events to session state transitions: session_start → active, session_update → refresh last_activity, session_end → ended [owner:engineer]
- [x] [3.3] Implement idle detection: mark sessions as idle after 5 minutes without heartbeat [owner:engineer]
- [x] [3.4] Add periodic idle-check sweep (run every 60s, check last_activity timestamps) [owner:engineer]

## 4. Integration
- [x] [4.1] Wire watcher subprocess startup into agent main entry point [owner:engineer]
- [x] [4.2] Ensure graceful watcher shutdown on agent SIGTERM/SIGINT [owner:engineer]

## 5. Validation
- [x] [5.1] Write integration test: spawn watcher mock, emit session_start → verify session created with status active [owner:engineer]
- [x] [5.2] Write integration test: session_start → no heartbeat for 5 min → verify status transitions to idle [owner:engineer]
- [x] [5.3] Write integration test: watcher crash → verify automatic restart and session state preserved [owner:engineer]
