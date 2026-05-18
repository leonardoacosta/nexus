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
| 1 | `session/` (list + detail)             | `nexus/nexus/SessionList.swift` + new `SessionDetailScene.swift` (wave 4) | partial | Sessions list shipped here; detail pane covered by `SessionDetailScene` on iOS. macOS still uses the legacy panel — refresh task tracked under bd:nx-gaquu. |
| 2 | `specs/`                               | `apps/swift/nexus-mac/Sources/Dashboard/SpecsView.swift` (wave 4) | done | Read-only, with SpecTransition SSE subscription. |
| 3 | `projects/`                            | `apps/swift/nexus-mac/Sources/Dashboard/ProjectsView.swift` (wave 4) | done | Lists distinct project ids derived from sessions. |
| 4 | `credentials/`                         | —            | missing | bd:nx-gaquu (Credentials view). Read-only mirror of cc-credential-manager status. |
| 5 | `failures/`                            | —            | missing | bd:nx-gaquu (Failures view). Query script_errors + recent failed notifications. |
| 6 | `notifications/`                       | —            | missing | bd:nx-gaquu (Notifications view). History + settings. |
| 7 | `settings/`                            | partial      | partial | TTS + Keychain panes exist via `ElevenLabsSettingsView`; full settings parity tracked under bd:nx-gaquu. |
| 8 | `health/`                              | partial      | partial | `MetricsRow` + Sparkline exist; full graphs gated on bd:nx-gaquu. |
| 9 | `integrations/`                        | —            | missing | bd:nx-gaquu. |
| 10| PTY viewer (xterm) under `session/<id>/stream` | — | missing | bd:nx-gaquu (SwiftTerm-based PTY pane reading /sessions/$id/stream WS). |

## Wave-4 deliverables (this commit)

- **Audit checklist** (this file)
- **SpecsView** (`apps/swift/nexus-mac/Sources/Dashboard/SpecsView.swift`) — task 1.3
- **ProjectsView** (`apps/swift/nexus-mac/Sources/Dashboard/ProjectsView.swift`) — task 1.4

## Deferred to bd:nx-gaquu

Tasks 1.5–1.11 (Credentials, Failures, Notifications, Settings, Health,
Integrations, PTY viewer) are the long tail. Each is ~150-500 LOC of
SwiftUI bound to NexusShared + new agent endpoints where applicable.
Filed as one consolidated bd issue so the dashboard parity backlog stays
visible. The retire-web-dashboard-infra spec MUST block on
bd:nx-gaquu closure.
