## 1. Components
- [x] [1.1] Build session card component displaying project name, hostname, status dot, duration, and last activity [owner:engineer]
- [x] [1.2] Build project group component with collapsible section per project [owner:engineer]
- [x] [1.3] Build status badge component for active/idle/ended states [owner:engineer]

## 2. Data Layer
- [x] [2.1] Implement Server Action for fetching sessions from all agents via @nexus/agent-client [owner:engineer]
- [x] [2.2] Add 5-second polling interval for real-time session updates [owner:engineer]
- [x] [2.3] Implement session sorting: active sessions first, then by last activity timestamp [owner:engineer]

## 3. UX States
- [x] [3.1] Implement empty state when no sessions are running (REQ-DASH-5) [owner:engineer]
- [x] [3.2] Add relative timestamp formatter (e.g., "3m ago", "2h ago") [owner:engineer]

## 4. Testing
- [x] [4.1] Write component tests for session card, project group, and status badge [owner:engineer]
- [x] [4.2] Write E2E test: dashboard renders sessions from 2 agents [owner:engineer]
