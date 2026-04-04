## 1. CLI Implementation
- [x] [1.1] Create apps/nexus-register package with Bun entry point and package.json [owner:engineer]
- [x] [1.2] Implement argument parser for subcommands: start, stop, heartbeat [owner:engineer]
- [x] [1.3] Implement start subcommand: write session_start event with session ID, project, PID, CWD, timestamp [owner:engineer]
- [x] [1.4] Implement stop subcommand: write session_end event with session ID and timestamp [owner:engineer]
- [x] [1.5] Implement heartbeat subcommand: write session_update event with session ID and timestamp [owner:engineer]

## 2. Project Detection
- [x] [2.1] Detect project code from $CWD by matching against known project paths [owner:engineer]
- [x] [2.2] Read CC environment variables (CLAUDE_SESSION_ID, etc.) for session ID and context [owner:engineer]
- [x] [2.3] Generate stable session ID from CC session context when env vars not available [owner:engineer]

## 3. Event File Output
- [x] [3.1] Ensure ~/.config/nexus/events/ directory exists (create if missing) [owner:engineer]
- [x] [3.2] Write event as JSON file with unique filename (timestamp + session ID) to events directory [owner:engineer]
- [x] [3.3] Define event JSON schema matching watcher IPC types from add-session-detection [owner:engineer]

## 4. Build
- [x] [4.1] Add bun build --compile script producing nexus-register single binary [owner:engineer]
- [x] [4.2] Add binary to agent install script alongside nexus-agent [owner:engineer]

## 5. Documentation
- [x] [5.1] Document CC hook configuration for SessionStart, SessionStop, PreToolUse in CLAUDE.md [owner:engineer]

## 6. Validation
- [x] [6.1] Write test: nexus-register start creates valid event file in events directory [owner:engineer]
- [x] [6.2] Write test: nexus-register stop creates valid event file with correct session ID [owner:engineer]
- [x] [6.3] Write test: nexus-register heartbeat creates update event [owner:engineer]
- [x] [6.4] Write test: project detection correctly identifies project from CWD [owner:engineer]
