# P5 Swift-Dashboard Parity Audit

Spec: openspec/changes/swift-dashboard-feature-parity (task 1.1)
Phase: P5 web-deprecation
Blocks: retire-web-dashboard-infra

This file enumerates every web page under `apps/nextjs/src/app/` and
tracks the Swift equivalent. The retire-web-dashboard-infra spec MUST
NOT begin until every row is checked.

## Audit rules

- One row per top-level web route. Sub-routes share the row of their parent unless they materially change UX (in which case they get their own row).
- "Swift target" identifies the file path under `apps/swift/nexus/nexus/` or `apps/swift/nexus-mac/Sources/` that implements the parity surface. Use `—` if the row is still missing.
- "Parity status" is one of:
  - `done` — Swift route exists, exposes the same actions, no known gaps.
  - `partial` — Swift route exists but is missing actions or polish.
  - `missing` — no Swift equivalent yet.
- All `partial` and `missing` rows MUST cite the bd issue tracking the gap.

## Routes

| # | Web route (`apps/nextjs/src/app/<x>`) | Swift target | Parity status | Notes / bd issue |
| - | -------------------------------------- | ------------ | ------------- | ---------------- |
| 1 | `session/` (list + detail)             | `apps/swift/nexus-mac/Sources/Dashboard/SessionsView.swift` (wave 4) | done | Sessions list parity. SessionObserver-bound; detail pane shared with iOS SessionDetailScene. Live SSE updates via NexusShared. |
| 2 | `specs/`                               | `apps/swift/nexus-mac/Sources/Dashboard/SpecsView.swift` (wave 4) | done | Read-only, with SpecTransition SSE subscription. |
| 3 | `projects/`                            | `apps/swift/nexus-mac/Sources/Dashboard/ProjectsView.swift` (wave 4) | done | Lists distinct project ids derived from sessions. |
| 4 | `credentials/`                         | `apps/swift/nexus-mac/Sources/Dashboard/CredentialsView.swift` (wave 5, bd:nx-gaquu) | done | Read-only CC-profile list bound to `NexusClient.fetchCredentials()`. Shows account email, OAuth state, 429 count, last swap. |
| 5 | `failures/`                            | `apps/swift/nexus-mac/Sources/Dashboard/FailuresView.swift` (wave 5, bd:nx-gaquu) | done | Aggregated `top_errors` feed bound to `NexusClient.fetchScriptErrors()`. 1d/7d/30d window picker; stack traces expand inline. |
| 6 | `notifications/`                       | `apps/swift/nexus-mac/Sources/Dashboard/NotificationsView.swift` (wave 5, bd:nx-gaquu) | done | HSplitView: live history pane + settings pane (meeting mode, suppression window, ducking, signal-only). Subscribes to `/notifications/stream`. |
| 7 | `settings/`                            | `apps/swift/nexus-mac/Sources/Dashboard/SettingsView.swift` (wave 5, bd:nx-gaquu) | done | Aggregator: TTS, Keychain status, agent connection, dashboard prefs. Reachability test built in. |
| 8 | `health/`                              | `apps/swift/nexus-mac/Sources/Dashboard/HealthView.swift` (wave 5, bd:nx-gaquu) | done | Three SwiftUI Charts (CPU/RAM/Disk) bound to `NexusClient.fetchHealthSeries()`. 10m/1h/6h/24h window picker. |
| 9 | `integrations/`                        | `apps/swift/nexus-mac/Sources/Dashboard/IntegrationsView.swift` (wave 5, bd:nx-gaquu) | done | Read-only list bound to `NexusClient.fetchIntegrations()`. Degrades to empty state on agents that only expose per-integration sub-routes. |
| 10| PTY viewer (xterm) under `session/<id>/stream` | `apps/swift/nexus-mac/Sources/Dashboard/PtyViewer.swift` (wave 5, bd:nx-gaquu) | done | SwiftTerm-based read-only viewer bound to `NexusClient.consumePtyStream()`. Pre-attach buffering, automatic reconnect with backoff. |

## Wave-4 deliverables

- **Audit checklist** (this file)
- **SpecsView** (`apps/swift/nexus-mac/Sources/Dashboard/SpecsView.swift`) — task 1.3
- **ProjectsView** (`apps/swift/nexus-mac/Sources/Dashboard/ProjectsView.swift`) — task 1.4

## Wave-5 deliverables (bd:nx-gaquu — this commit)

Tasks 1.5–1.11 shipped together as the long-tail dashboard parity work
that gates retire-web-dashboard-infra:

- **CredentialsView** (`apps/swift/nexus-mac/Sources/Dashboard/CredentialsView.swift`) — task 1.5
- **FailuresView** (`apps/swift/nexus-mac/Sources/Dashboard/FailuresView.swift`) — task 1.6
- **NotificationsView** (`apps/swift/nexus-mac/Sources/Dashboard/NotificationsView.swift`) — task 1.7
- **SettingsView** (`apps/swift/nexus-mac/Sources/Dashboard/SettingsView.swift`) — task 1.8
- **HealthView** (`apps/swift/nexus-mac/Sources/Dashboard/HealthView.swift`) — task 1.9
- **IntegrationsView** (`apps/swift/nexus-mac/Sources/Dashboard/IntegrationsView.swift`) — task 1.10
- **PtyViewer** (`apps/swift/nexus-mac/Sources/Dashboard/PtyViewer.swift`) — task 1.11

Supporting changes:

- New NexusShared models: `CcProfile`, `ScriptError`, `IntegrationStatus`
  (`apps/swift/NexusShared/Models/`)
- NexusClient extensions: `fetchCredentials()`, `fetchScriptErrors()`,
  `fetchHealthSeries()`, `fetchIntegrations()`, `consumeNotifications()`,
  `consumePtyStream()` (`apps/swift/NexusShared/Networking/NexusClient.swift`)
- Dashboard scene wired via `AppNavigation.swift` +
  `WindowGroup("Nexus Dashboard")` in `nexusApp.swift`
- SwiftTerm added as a `nexus-mac` dependency in `apps/swift/project.yml`

retire-web-dashboard-infra is now unblocked from the parity-audit side;
remaining gate is the agent-side `GET /integrations` endpoint (older
agents return 404, view degrades gracefully).
