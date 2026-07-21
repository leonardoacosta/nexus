---
order: 0719a
---

# Optimize Board Render Hot Paths

## Why

The board work list is already virtualized (`ScrollView` + `LazyVStack`,
`BoardView.swift:160-181`) — offscreen rows never build. The measured rendering cost is
upstream in data derivation:

1. `BoardViewModel.visibleItems` (`BoardModel.swift:291-314`) is an unmemoized computed
   property that filters + sorts the entire `allItems` array (thousands of rows, including
   phantom UUID orphans — nx-2yy5p.1) on **every access**. It is read 4+ times per render
   pass (`isEmpty` check, `ForEach`, `.onChange`, and `visibleStats`, which itself re-filters
   the result 3 more times).
2. Every `BoardRow` carries `.animation(..., value: model.visibleItems)`
   (`BoardView.swift:175-179`), forcing a whole-array `Equatable` comparison per row per
   change — O(rows x arraySize).
3. Phantom unregistered-project orphans already collapse into one `__unregistered__` rail
   bucket, but their thousands of items still flow through `allItems` into the All work
   list, inflating every derivation above.

## What Changes

- Memoize `visibleItems` into a stored `@Published` value recomputed only when its inputs
  change (`allItems`, `statusFilters`, `orphansOnly`, `sortKey`, `selectedProject`), not per
  access. `visibleStats` derives from the memoized value in one pass.
- Remove the per-row array-keyed `.animation`; attach a single animation at the list
  container level (or key rows on scalar identity) so row insert/remove still animates.
- Scope the work list: unregistered-bucket orphans no longer render in the All work list;
  they render only when the synthetic Unregistered rail row is selected. Registered-project
  orphans are unchanged (decision: Leo, 2026-07-19; extends the existing rail-bucket
  band-aid for nx-2yy5p.1).

## Context

- touches: `apps/swift/nexus-mac/Sources/Dashboard/BoardModel.swift`, `apps/swift/nexus-mac/Sources/Dashboard/BoardView.swift`

Swift-only change (nexus-mac). No API/DB surface touched. Dispatch `swift-engineer`
per-spec (nx has no project.toml — t3 mega-batch UI agent cannot build Swift).

## Impact

- Affected specs: `project-structure-board` (MODIFIED orphan-row scoping, ADDED derivation
  requirement)
- Affected code: `BoardModel.swift` (memoization, unregistered scoping), `BoardView.swift`
  (animation relocation, stats consumption)
- No wire/protocol changes; `NexusShared` untouched.

## Done Means

- Board list scrolls smoothly with thousands of beads loaded — no per-frame full-array
  filter+sort.
- Toggling a status filter, changing sort, or switching rail selection re-derives the
  visible list exactly once per change.
- Row insert/remove animation still visually works after the animation relocation.
- Selecting All shows registered-project rows only; selecting the Unregistered rail row
  still reveals the phantom-orphan backlog.

## Testing

- Unit: not applicable — `BoardViewModel` has no existing XCTest target on the Linux-side
  CI path; verification is typecheck + on-device (below).
- Machine gate: `ssh mac` + `swiftc -typecheck` over nexus-mac sources (task 1.4) passes
  with zero errors.
- On-device: manual verification checklist (User Gate task 2.1) — scroll performance with
  All selected, filter toggle latency, animation integrity, Unregistered bucket behavior.
