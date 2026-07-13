# Proposal: Refocus Board Shell (project-structure board replaces the nav sprawl)

## Change ID

`refocus-board-shell`

## Summary

Refocus nexus-mac from 12 peer sidebar sections into one project-structure board: the project
rail is the only selector (with `All` at the top), OpenSpec proposals render as first-class
expandable rows with live task rollups, orphan (proposal-unlinked) beads sit at the same top
level, and a detail rail carries spec content, approve/reject, dependencies, and recent TTS.
Full nav restructure in this change: Roadmap/Specs/Projects tabs are deleted (the board IS
them), the Decide deck becomes approve/reject actions on proposal rows, Failures/Health become
badges + drawer entries, PTY Viewer becomes an attach sheet, Notifications becomes a slide-over
drawer, and Credentials/Integrations/Sources/Voices re-home under one Settings pane. Agent side
adds `project=all` fan-out aggregation and description fields to the existing
`bead-proposal-roadmap` surfaces. Design source of truth:
`docs/diagrams/nx-refocus-board.html` (sections 01–07).

## Context

- touches: `apps/agent/src/routes/roadmap.ts`, `apps/agent/src/routes/beads-unlinked.ts`, `apps/agent/src/services/roadmap-aggregate.ts`, `apps/agent/src/services/bead-rollup.ts`, `packages/core/src/types/roadmap.ts`, `packages/core/src/types/spec.ts`, `apps/swift/nexus-mac/Sources/AppNavigation.swift`, `apps/swift/nexus-mac/Sources/Dashboard/BoardView.swift`, `apps/swift/nexus-mac/Sources/Dashboard/BoardViewModel.swift`, `apps/swift/nexus-mac/Sources/Dashboard/BoardDetailRail.swift`, `apps/swift/nexus-mac/Sources/Dashboard/NotificationDrawer.swift`, `apps/swift/nexus-mac/Sources/Dashboard/AttachSheet.swift`, `apps/swift/nexus-mac/Sources/Dashboard/SettingsPane.swift`, `apps/swift/nexus-mac/Sources/Dashboard/RoadmapView.swift`, `apps/swift/nexus-mac/Sources/Dashboard/SpecsView.swift`, `apps/swift/nexus-mac/Sources/Dashboard/SpecDetailView.swift`, `apps/swift/nexus-mac/Sources/Dashboard/ProjectsView.swift`, `apps/swift/nexus-mac/Sources/Dashboard/ProjectAccordionRow.swift`, `apps/swift/nexus-mac/Sources/Dashboard/FailuresView.swift`, `apps/swift/nexus-mac/Sources/Dashboard/HealthView.swift`, `apps/swift/nexus-mac/Sources/Dashboard/NotificationsView.swift`, `apps/swift/NexusShared/Models/Roadmap.swift`, `apps/swift/NexusShared/Networking/NexusClient.swift`, `apps/swift/NexusShared/Networking/NexusAggregateClient.swift`, `apps/swift/nexus-mac/project.yml`

No `- depends on:` line — there are no in-flight specs; the ticker queue contract
(`refocus-ticker-queue`) is authored separately and shares no files with this change.

## Motivation

nexus-mac accumulated 12 peer sidebar destinations plus an off-sidebar Decide deck. Sessions,
credentials, failures, integrations, health, and the PTY viewer all read as equally important as
the actual work structure, and Roadmap + Specs are two separate tabs rendering the same beads
data (~1,450 lines combined). Leo's daily question — "what is the state of my projects'
proposals and unplanned work" — has no single answer surface. The agent already ships the exact
contract the board needs (`GET /roadmap`, `GET /beads/unlinked`, `GET /specs/*`,
approve/reject); this change is a re-composition of existing data, not new plumbing.

## Requirements (canonical text in `specs/` deltas)

1. **All-projects roadmap aggregation** (bead-proposal-roadmap delta, ADDED):
   `GET /roadmap?project=all` fans out `computeRoadmap` across every registered non-hidden
   project concurrently and returns the merged capability list, each entry tagged with its
   `project` code. Per-project failures degrade to that project's exclusion, never a 500.
2. **All-projects unlinked aggregation** (bead-proposal-roadmap delta, ADDED): same fan-out for
   `GET /beads/unlinked?project=all`, entries tagged with `project`.
3. **Bead descriptions on the wire** (bead-proposal-roadmap delta, ADDED): `BeadRef` and
   `UnlinkedBead` gain an optional `description` field populated from `bd list` output so board
   rows can expand to a description without a second fetch.
4. **Board shell** (project-structure-board delta, ADDED — new capability): the mac dashboard's
   primary window is the board — project rail (sole selector, `All` first, live counts),
   proposal rows (expand → tasks → descriptions), orphan beads at top level, `All` mode tags
   rows with project code, detail rail (description, tasks, dependencies, spec content, recent
   TTS, approve/reject, attach).
5. **Nav collapse** (project-structure-board delta, ADDED): `DashboardSection` reduces to
   `board` + `settings`; Roadmap, Specs, Projects, Failures, Health, Notifications,
   Credentials, Integrations, Sources, PTY sections are removed from the sidebar.
6. **Decide absorption** (project-structure-board delta, ADDED): approve/reject on proposal
   rows + detail rail via the existing `POST /specs/.../approve|reject`; the standalone Decide
   deck is removed.
7. **Ambient absorptions** (project-structure-board delta, ADDED): notification drawer
   (slide-over inheriting NotificationsView's history/replay/meeting-mode, plus failure
   entries), failure/health badges (titlebar homelab presence dot + on-demand process table
   popover; failure badge on affected rows), attach sheet (PtyViewer behavior re-homed as a
   sheet with Stream/Full modes).
8. **Settings pane** (project-structure-board delta, ADDED): Credentials, Integrations,
   Sources, Voices, General re-homed as tabs of one Settings window — existing views re-homed,
   not rewritten.

## Scope

- In: agent `project=all` aggregation + description fields (+ tests), core wire types, full
  nexus-mac nav restructure per requirements 4–8, view deletions, XcodeGen `project.yml`
  updates, headless Swift typecheck gate.
- Out: the TTS ticker 30s-TTL queue contract (separate `refocus-ticker-queue` spec), iOS/watch
  board adoption (follow-up spike bead filed by this change), the legacy
  `apps/swift/nexus/` menubar app (untouched — separate deprecation decision), any agent route
  deprecations (usage audit first), beads/openspec write operations beyond the existing
  approve/reject.

## Testing

| Seam | Coverage |
| --- | --- |
| `GET /roadmap?project=all` fan-out, merge, project tags, per-project degradation | Route tests, task 4.1 |
| `GET /beads/unlinked?project=all` fan-out + tags | Route tests, task 4.1 |
| `description` populated on `BeadRef`/`UnlinkedBead`, absent tolerated | Unit tests on bead-rollup, task 4.1 |
| Single-project param behavior unchanged (wire back-compat) | Existing route tests kept green, task 4.1 |
| Board view model: rail counts, All merge, orphan interleave, expand state | Swift unit tests where harness allows; else headless typecheck + on-device checklist, task 4.2 |
| Nav collapse, drawer, attach sheet, settings pane | `[user]` on-device verification checklist (GUI-bound), task 4.2 — searched: apps/swift has no UI test target in project.yml and codesign/GUI gates block headless UI runs (see reference_mac_swift_deploy memory); no documented pattern covers headless SwiftUI interaction testing on this fleet |
| Decide absorption approve/reject round-trip | Existing `/specs` approve/reject route tests unchanged; Swift action wiring in on-device checklist, task 4.2 |

## Impact

- Agent: two routes gain an `all` branch; `bead-rollup`/`roadmap-aggregate` carry descriptions;
  wire types additive-only (existing single-project consumers unaffected).
- nexus-mac: ~4,900 lines of section views deleted or re-homed; new Board* + drawer + sheet +
  settings files; `DashboardSection` 12 → 2; default view `nx.dashboard.defaultView` becomes
  `board`.
- NexusShared: `Roadmap.swift` gains `project`/`description` decode; client methods gain the
  `all` variants.
- iOS/watch: no behavior change in this spec (shared model additions are optional-decode).

## Risks

- Fan-out latency on `project=all` with many registered projects — bounded by concurrent
  execution and per-project degradation; the board renders progressively from per-project
  responses if needed.
- Deleting 6+ section views in one change risks orphaned references (coordinator deep-links,
  UserDefaults section restore) — mitigated by compiling the full app via the headless
  typecheck gate and a grep sweep for deleted symbol names.
- GUI-bound verification (drawer/sheet/settings) cannot be proven headlessly — explicitly
  carried as a `[user]` on-device checklist task rather than silently claimed.
- Bun test suite cross-contamination via `mock.module` when extending agent route tests —
  follow the restorable-spy pattern (see memory: bun mock.module contamination).
