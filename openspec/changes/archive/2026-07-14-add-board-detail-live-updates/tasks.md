<!-- beads:epic:nx-usn4z -->
<!-- beads:feature:nx-wvlwo -->

# Tasks: Add Board Detail Live Updates

## API Batch

- [x] Add an owning-agent resolution method to `NexusAggregateClient` (e.g. [beads:nx-yq507]
      `resolveOwningAgent(project:) async -> AgentIdentity?`), reusing the same
      fan-out-and-first-success pattern `fetchSpecContent` already uses to find which single
      agent answers for a project
      - depends on: `add-board-detail-content-cache` (this change treats `SpecContentCache` as
        the target of invalidation, not a parallel data path)
      - touches: `apps/swift/NexusShared/Networking/NexusAggregateClient.swift`
- [x] Wire `BoardDetailModel` (`BoardDetailRail.swift`) to open one `NexusClient.consumeSpecEvents` [beads:nx-9rh9c]
      SSE connection to the resolved owning agent when a proposal is selected, and cancel it on
      deselection or a different-row selection before any new connection opens
      - touches: `apps/swift/nexus-mac/Sources/Dashboard/BoardDetailRail.swift`
- [x] On a received `SpecTransition` event matching the open item's (project, slug), invalidate [beads:nx-bb8jl]
      the corresponding `SpecContentCache` entry and trigger its existing revalidation fetch;
      ignore events for any other (project, slug)
      - touches: `apps/swift/nexus-mac/Sources/Dashboard/BoardDetailRail.swift`
- [x] Add reconnect-with-exponential-backoff to the SSE connection, triggering one immediate [beads:nx-36t1g]
      cache revalidation on successful reconnect (matches the reconnect-then-refetch precedent
      from the archived `add-spec-page-live-updates` proposal)
      - touches: `apps/swift/nexus-mac/Sources/Dashboard/BoardDetailRail.swift`
- [x] When an orphan bead row is selected, observe `SessionObserver.lastBeadTransition` and [beads:nx-wu2ew]
      refetch/re-render the orphan's detail when a transition arrives matching its project
      - touches: `apps/swift/nexus-mac/Sources/Dashboard/BoardDetailRail.swift`

## E2E Batch

- [x] Unit test: the owning-agent resolution helper returns the correct single agent given a [beads:nx-1ozxy]
      multi-agent fixture, mirroring the existing `fetchSpecContent` fan-out test pattern
- [x] Unit test: a `SpecTransition` event for the currently-open (project, slug) invalidates and [beads:nx-5pobu]
      revalidates the matching cache entry; a transition for a different (project, slug) is a
      no-op
- [x] Unit test: deselecting a proposal (or selecting a different one) cancels the open SSE [beads:nx-d9vc1]
      connection before a new one opens for the new selection
- [ ] [user] Manual on-device verification — searched: checked for an existing CI/simulator [beads:nx-4vpqk]
      harness exercising live SSE push against a real running agent (`nexus-mac-UITests`) — those
      targets exercise static fixtures only, no documented pattern covers verifying a live
      network push loop end-to-end against a real agent process, this genuinely needs a human.
      (Headless Mac build gate, per the swift-engineer standard `ssh mac` + `xcodebuild`
      contract): open a proposal in the detail rail, edit its `tasks.md` on the owning machine,
      and confirm the detail rail's task rollup updates within the ~5s coalescing window without
      reselecting the row; confirm reselecting a different row and back closes/reopens the
      connection cleanly with no duplicate events.
