<!-- beads:epic:nx-usn4z -->
<!-- beads:feature:nx-vu9op -->

# Tasks: Add Board Detail Content Cache

## API Batch

- [x] Create `apps/swift/nexus-mac/Sources/Dashboard/SpecContentCache.swift`: an `actor`-isolated [beads:nx-p4n6d]
      in-memory cache keyed by a `CacheKey { project, slug, file }` struct, storing content plus a
      `CacheState` enum (`.cachedOnly`, `.fetchInFlight`, `.fresh(Date)`)
      - depends on: none
      - touches: `apps/swift/nexus-mac/Sources/Dashboard/SpecContentCache.swift`
- [x] Add a `fetch(key:using:)` method on `SpecContentCache` that: returns cached content [beads:nx-mgwzr]
      synchronously if present (marking state `.cachedOnly` until revalidated), always kicks a
      background refetch via the passed `NexusAggregateClient.fetchSpecContent` closure, and
      updates state to `.fresh(Date())` on success
      - touches: `apps/swift/nexus-mac/Sources/Dashboard/SpecContentCache.swift`
- [x] Rewire `BoardDetailModel.loadContent(project:slug:)` (`BoardDetailRail.swift`) to read [beads:nx-jnlh7]
      through `SpecContentCache` instead of calling `NexusAggregateClient.fetchSpecContent`
      directly; publish the cache state alongside content so the view can render the indicator
      - depends on: `SpecContentCache.swift` existing
      - touches: `apps/swift/nexus-mac/Sources/Dashboard/BoardDetailRail.swift`

## UI Batch

- [x] Add a small cache-state indicator view in `BoardDetailRail`'s proposal detail header: [beads:nx-mzsrb]
      cached-only (dim dot), fetch-in-flight (small `ProgressView`), fresh (checkmark + relative
      timestamp via `Text(date, style: .relative)`)
      - touches: `apps/swift/nexus-mac/Sources/Dashboard/BoardDetailRail.swift`
- [x] Add a bounded prefetch trigger: when `BoardViewModel.visibleItems` changes, call [beads:nx-jge1j]
      `SpecContentCache.fetch` for the default (`proposal.md`) tab of the first 20 visible
      `.proposal` rows (skip `.orphan` rows), in the background, via `.onChange` in `BoardView`
      or a computed trigger in `BoardViewModel`
      - depends on: `SpecContentCache.swift` existing
      - touches: `apps/swift/nexus-mac/Sources/Dashboard/BoardView.swift`, `apps/swift/nexus-mac/Sources/Dashboard/BoardModel.swift`

## E2E Batch

- [x] Unit test: `SpecContentCache` returns cached content on second read without waiting for the [beads:nx-agwvz]
      background refetch, and transitions `.cachedOnly` → `.fetchInFlight` → `.fresh(Date)`
      correctly across a rapid sequence of selections (actor isolation holds under concurrency)
- [x] Unit test: the prefetch trigger requests exactly the first 20 visible `.proposal` rows' [beads:nx-lftx2]
      `proposal.md` (never `.orphan` rows, never `design`/`tasks` tabs) when `visibleItems`
      changes, and skips rows already `.fresh` in the cache
- [ ] [user] Manual on-device verification — searched: checked for an existing CI/simulator [beads:nx-vw9oj]
      harness that could automate this (`apps/swift/nexus-mac/Tests/`, `nexus-mac-UITests`) — UI
      test targets exist but exercise static fixtures, not live network/cache timing behavior; no
      documented pattern covers verifying perceived-latency/animation smoothness
      programmatically, this genuinely needs a human looking at the running app. (Headless Mac
      build gate, per the swift-engineer standard `ssh mac` + `xcodebuild` contract): confirm
      re-selecting a previously-opened proposal renders instantly with no spinner, the indicator
      visibly cycles through all three states on a first-ever selection, and filtering/sorting
      the board does not visibly stutter or block while prefetches run in the background
