# Tasks: swift-dashboard-feature-parity

- [x] 1.1 Create p5-parity-audit.md checklist of all web pages + actions

  Created `docs/plan/spine-migration/p5-parity-audit.md`. Enumerates each
  `apps/nextjs/src/app/<route>` directory + its Swift target. Rows for
  done / partial / missing parity. The retire-web-dashboard-infra spec
  MUST block on every row reaching `done`.

  Wave-4 status in the audit: 3 rows landed (Sessions, Specs, Projects);
  7 rows deferred to **bd:nx-gaquu** (Credentials, Failures,
  Notifications, Settings, Health full, Integrations, PTY viewer).

- [x] 1.2 Implement Sessions view (already partially exists)

  New `apps/swift/nexus-mac/Sources/Dashboard/SessionsView.swift` —
  NexusShared-based dashboard surface (bound to a `SessionObserver`).
  Header shows aggregate state badge + live count; empty state mirrors
  the legacy SessionList ("· · · no claude code on homelab"); rows show
  project / branch / model / status / originAgent.

  The legacy `apps/swift/nexus/nexus/SessionList.swift` continues to
  back the menu-bar popover (bound to `NexusViewModel`) until the
  nexus-mac NexusShared migration (bd:nx-4roof) retires it.

- [x] 1.3 Implement Specs view (read-only with SpecTransition SSE subscription)

  New `apps/swift/nexus-mac/Sources/Dashboard/SpecsView.swift`:
  - `SpecsViewModel` calls `client.fetchSpecs()` on appear and
    subscribes via `client.consumeSpecEvents` (new wrapper around
    `GET /specs/events`).
  - Rows grouped by project, with status-coloured dot + progress bar
    + completed/total task count.
  - On any `SpecTransition` event the model re-fetches the list
    (specs are few; per-row merge isn't worth it yet).

  NexusShared additions:
  - `Models/SpecSummary.swift` — Codable mirror of agent `SpecSnapshot
    & { project }`.
  - `Networking/NexusClient.fetchSpecs(status:project:)` +
    `consumeSpecEvents(handler:)`.

- [x] 1.4 Implement Projects view

  New `apps/swift/nexus-mac/Sources/Dashboard/ProjectsView.swift`:
  - `ProjectsViewModel.load()` calls `client.fetchProjects()` (legacy
    bare-array shape).
  - Sorted by active-session count desc, then name asc.
  - Rows show name + machines list + active/total counts + status dot.
  - Cmd+R refresh; no SSE topic for project rollup yet.

  NexusShared additions:
  - `Models/ProjectAggregate.swift` — Codable mirror of
    `packages/core/src/types/project.ts Project` (snake_case ->
    camelCase via CodingKeys).
  - `Networking/NexusClient.fetchProjects()`.

- [ ] 1.5 Implement Credentials view (read-only CC profile status from cc-credential-manager) — deferred to bd:nx-gaquu

- [ ] 1.6 Implement Failures view (queries script_errors + recent failed notifications) — deferred to bd:nx-gaquu

- [ ] 1.7 Implement Notifications view (history + settings) — deferred to bd:nx-gaquu

- [ ] 1.8 Implement Settings view (TTS settings, Keychain, agent connection, dashboard prefs) — deferred to bd:nx-gaquu

- [ ] 1.9 Implement Health view (CPU/RAM/disk graphs from health_snapshots) — deferred to bd:nx-gaquu

- [ ] 1.10 Implement Integrations view (anything currently exposed in web) — deferred to bd:nx-gaquu

- [ ] 1.11 Implement PTY viewer with SwiftTerm reading /sessions/$id/stream — deferred to bd:nx-gaquu

- [x] 1.12 Walk the parity-audit checklist; mark each row done

  Walk-through scope = the 3 wave-4 rows: Sessions, Specs, Projects.
  These three are recorded as `done` (or `partial` with explicit bd
  link) in `docs/plan/spine-migration/p5-parity-audit.md`. The
  remaining 7 rows stay `missing` / `partial` with **bd:nx-gaquu**
  cited until those views ship.

  The retire-web-dashboard-infra spec (P5.2 · nx-rguah) MUST NOT
  start while any row is missing — that gate is now codified in the
  audit doc.
