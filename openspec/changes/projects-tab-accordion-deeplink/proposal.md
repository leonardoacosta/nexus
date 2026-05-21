---
status: draft
---

# Proposal: projects-tab-accordion-deeplink

## Why

The Swift dashboard's Projects tab is a flat read-only list. You can see
that `nx` has 2 sessions on homelab, but you can't see *which* sessions,
what git branch each project is on, or jump into any of them. The fix
is one consolidated rewrite that turns each project row into an
expandable accordion carrying git metadata and the live session list,
with a deep link from any session into the Sessions tab + PTY.

This is the second of the 7-spec UX backlog. It pairs naturally with
`specs-tab-start-on-spec` (just scaffolded) — both add session affordances
to non-Sessions tabs, both reuse the existing `PtyViewer` from the
Sessions tab. Together they remove the "context-switch to Sessions tab"
penalty for the two highest-traffic entry points (specs and projects).

## What Changes

1. **Accordion row in `ProjectsView`** — current `ProjectRow` (read-only
   counts) is replaced by an expandable `ProjectAccordionRow`. Collapsed
   shows project name + active-session count + git branch chip.
   Expanded shows full git metadata + a nested list of live sessions.
   Default state: collapsed when 0 sessions, expanded when 1+ active
   sessions on first load. User-toggle is sticky via `@AppStorage`
   keyed by project id.

2. **Extended git metadata** — `apps/agent/src/services/git-project.ts`
   gains a `getGitMetadata(cwd)` function returning
   `{ branch, ahead, behind, dirty, lastCommit: { author, ts } }` on
   top of the existing `{ provider, ownerRepo }`. Per-cwd cache with
   30s TTL. `GET /projects` includes the metadata for every project.

3. **Deep-link click handler** — clicking a session row inside the
   accordion (a) switches the dashboard tab to Sessions, (b) scrolls
   the matching session row into view via SwiftUI's
   `ScrollViewReader.scrollTo`, and (c) programmatically opens its
   PTY in the right pane. Implemented via a shared
   `DashboardNavigationCoordinator` actor passed through the
   environment.

4. **Programmatic SessionsView API** — `SessionsView` exposes
   `openSession(_ id: String)` consumed by the coordinator. The
   existing tap-to-open path stays unchanged; the new API just
   threads the same handler with a synthetic `selectedSessionId`
   write so the right pane swaps to `PtyViewer`.

5. **AppNavigation tab-switch hook** — `AppNavigation` already owns
   the tab enum. Add an `onChange` consumer + a published
   `pendingDeepLink: DeepLink?` so the destination view can drain
   the request on appear. Pattern mirrors the iOS deep-link
   conventions (URL-state-then-clear).

## Context

- depends on: 
- touches: `apps/agent/src/services/git-project.ts`, `apps/agent/src/services/git-project.test.ts`, `apps/agent/src/routes/projects.ts`, `apps/agent/src/routes/projects.test.ts`, `apps/swift/NexusShared/Models/ProjectSummary.swift`, `apps/swift/NexusShared/Models/GitMetadata.swift`, `apps/swift/NexusShared/Networking/NexusClient.swift`, `apps/swift/NexusShared/Networking/NexusAggregateClient.swift`, `apps/swift/nexus-mac/Sources/Dashboard/ProjectsView.swift`, `apps/swift/nexus-mac/Sources/Dashboard/ProjectAccordionRow.swift`, `apps/swift/nexus-mac/Sources/Dashboard/SessionsView.swift`, `apps/swift/nexus-mac/Sources/AppNavigation.swift`, `apps/swift/nexus-mac/Sources/Dashboard/DashboardNavigationCoordinator.swift`

Capability ownership: primary `swift-menubar-client` (owns ProjectsView
+ AppNavigation), secondary `project-registry` (owns GET /projects
contract — needs the metadata field extension).

Wave-plan-build conflict: `NexusClient.swift` and `NexusAggregateClient.swift`
are also touched by the just-scaffolded `specs-tab-start-on-spec`. Both
specs append new methods to these clients; the conflict matrix will
serialize them into different waves. Both can be authored in parallel
as drafts — there's no logical dependency, just the shared-file
collision. The append-only nature of the changes means whichever lands
first does not block the other.

## Risk

- **Git metadata cost.** `git status --porcelain --branch` per project
  per `GET /projects` is ~50-200ms on a clean repo, up to 1-2s on a
  large dirty one. Mitigation: 30s TTL cache per cwd, parallel
  execution across projects (Promise.all), drop the slowest decile
  with a `metadata: null` field. `GET /projects` SHALL remain under
  500ms p95 even on a host with 20+ tracked projects.
- **Cross-platform git command parity.** macOS bundled git ≥ 2.30 and
  Linux distros vary. `--porcelain=v2` is universally supported back to
  2.11 and gives stable parse output — use that. Fall back to `null`
  metadata if the parser fails; never throw.
- **Deep-link race during PTY mount.** If the user clicks rapidly across
  two sessions, the second click may arrive before the first PTY's
  WebSocket has finished its handshake. Mitigation: the deep-link
  coordinator cancels the in-flight open before issuing the next one.
  PTY component already idempotent for this case (commit eaa1a98
  shipped the 6s watchdog + cancel-button paths).
- **Sticky expand state pollution.** Long-lived `@AppStorage` keyed
  on `project.id` can leak after a project is removed. Mitigation:
  prune storage entries on ProjectsView.task() that don't match any
  current project id. Cheap O(N).
