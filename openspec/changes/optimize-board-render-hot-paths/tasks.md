---
stack: t3
---
<!-- beads:epic:nx-usn4z -->
<!-- beads:feature:nx-ji265 -->

# Tasks: Optimize Board Render Hot Paths

## UI Batch

- [x] 1.1 Memoize `visibleItems` in `apps/swift/nexus-mac/Sources/Dashboard/BoardModel.swift`: replace the computed property (lines ~291-314) with a stored `@Published private(set) var visibleItems: [BoardWorkItem]` recomputed by a single `recomputeVisible()` invoked from `load()` completion and `didSet`/`onChange` of `statusFilters`, `orphansOnly`, `sortKey`, `selectedProject`. `visibleStats` derives from the stored array in one pass (no triple re-filter). [beads:nx-a2do3]
- [x] 1.2 In `BoardModel.swift`, scope unregistered-bucket orphans out of the All work list: `recomputeVisible()` excludes items whose bucket is `Self.unregisteredCode` when `selectedProject == nil` (All); when `selectedProject == Self.unregisteredCode` they are the visible set. Registered-project behavior unchanged; rail counts unchanged. [beads:nx-rk2c4]
- [x] 1.3 In `apps/swift/nexus-mac/Sources/Dashboard/BoardView.swift`, remove `.animation(..., value: model.visibleItems)` from each `BoardRow` (lines ~175-179); attach one `.animation` at the `LazyVStack`/list container keyed to the memoized array (single comparison per change), preserving insert/remove animation. [beads:nx-mrdm9]
- [x] 1.4 Typecheck gate: from Linux, run the headless Mac typecheck (`ssh mac` + `swiftc -typecheck` over nexus-mac sources per the swift-engineer contract) and paste passing output; zero errors. [beads:nx-mmo1s]

## User Gate

- [ ] 2.1 [user:post] On-device verification on the Mac (GUI-bound): with All selected and a full fleet load, confirm smooth scroll, sub-100ms filter-chip toggle, intact row insert/remove animation, phantom orphans absent from All but present under the Unregistered rail row. searched: nx open beads + archived board specs for an existing board perf verification checklist; only per-feature on-device checklists exist (e.g. nx-4y16k), none covers derivation perf — new manual step required. [beads:nx-icutm]
