---
status: current
updated: 2026-07-15
---

# Spike: project-structure board → nexus-ios Scenes navigation

> Spec: `openspec/changes/extend-ios-companion-features` task 4.5 (nx-szfbk / nx-ghrhb)
> Status: complete — UI-shape assessment only, no code shipped.
> Question answered: does the Mac project-structure board map cleanly onto the
> nexus-ios navigation primitives, and should an iOS board be scheduled?

## What the board is (source of truth)

The Mac board is a **three-column NavigationSplitView** (`apps/swift/nexus-mac/Sources/Dashboard/`):

| Column | File | Behaviour |
| ------ | ---- | --------- |
| Project rail (the ONLY selector) | `BoardView.swift` `rail` | `All` row + one row per project, each with an open-count. Selecting a row is a **pure client-side filter** — no refetch. |
| Flattened work list | `BoardView.swift` + `BoardModel.swift` | Capability→proposal tree is flattened to top-level **proposal rows** (capability demoted to a muted tag); **orphan beads** (`/beads/unlinked`) are interleaved at the same level. `BoardWorkItem = .proposal \| .orphan`. Status/priority columns + filter chips. |
| Detail rail (right inspector) | `BoardDetailRail.swift` | Proposal → spec markdown (proposal/design/tasks tabs via `fetchSpecContent`), linked beads, recent TTS, approve/reject/attach. Orphan → degrades to the bead's description + status. |

Data source (`BoardModel.swift`): the view model always fetches the **fleet-wide
`all` variants** — `fetchRoadmapAll()` + `fetchUnlinkedBeadsAll()` — so every item
arrives tagged with its owning `project`; the rail is a client-side derivation over
that one dataset.

## What nexus-ios already has

`RootScene.swift` is a `TabView` (selection-bound to `NavigationState.selectedTab :
RootTab`) where **each tab is its own `NavigationStack`**, and the archetype
"list row → push a detail scene" already appears 6+ times (Sources, Comms, Calendar,
Finance, Health, Meds, Sessions, Notifications). The Sessions tab is the reference
for value-typed deep navigation:

```swift
NavigationStack(path: $navigation.sessionPath) {           // sessionPath: [String]
    SessionsArchetypeScene()
        .navigationDestination(for: String.self) { id in AttachScene(sessionId: id) }
}
```

`NavigationState` (`App/NavigationState.swift`) already models value-typed paths +
cross-tab deep-link routing (`handle(deepLink:)`, `selectedTab` switch before append).

**Client wiring already present in NexusShared** (verified — no new networking needed,
as the spec asserts): `fetchRoadmapAll()`, `fetchUnlinkedBeadsAll()`, `fetchProjects()`,
`fetchSpecContent()`, `fetchSpecs()`; models `RoadmapCapability`/`RoadmapProposal`,
`UnlinkedBead` (with the additive-optional `project?` + `description?` decode this spike
needs), `SpecSummary`.

## The mapping

| Board element (Mac, side-by-side panes) | nexus-ios primitive (sequential push) | Fit |
| --------------------------------------- | ------------------------------------- | --- |
| **Rail selector** (`All` + per-project, client-side filter) | A `RootTab.board` tab hosting a `BoardScene`; the rail becomes a leading **project picker** — a horizontally-scrolling chip row or a toolbar `Menu`/`Picker` bound to `@Published selectedProject: String?`. Same client-side filter over the one `all` dataset. Rail is NOT a persistent column on a phone. | Clean — it is state, not chrome. |
| **Proposal rows + orphan beads** (interleaved `BoardWorkItem` list) | The `List` in `BoardScene`. `BoardWorkItem` is already `Identifiable + Hashable`, so each row is `NavigationLink(value:)` appending to a value-typed `boardPath: [BoardWorkItem]`. | Clean — identical to the Sessions `[String]` path, one type up. |
| **Detail rail** (proposal spec tabs / orphan description) | A pushed `BoardDetailScene(item:)` via `.navigationDestination(for: BoardWorkItem.self)`. Proposal → `fetchSpecContent` markdown + linked beads + Attach; orphan → description + status. This is the existing `DetailScene`/`NotificationDetailScene` archetype. | Clean — collapses the 3rd pane to a push, standard iOS. |
| **Attach affordance** on a proposal detail | Reuse the existing cross-tab pattern: set `selectedTab = .sessions`, append the session id to `sessionPath`. | Clean — already implemented. |
| **APNS / `nexus://` deep-link into a board item** | Extend `NavigationState` with `boardPath: [BoardWorkItem]` + a `RootTab.board` deep-link case, mirroring `sessionPath`. | Clean — additive to an existing mechanism. |

### The one real shape mismatch

Mac shows rail + list + detail **simultaneously**; a phone shows them **sequentially**
(picker-as-state → list → pushed detail). This is the normal split-view→stack collapse
and is idiomatic iOS — an iPad build could later restore true `NavigationSplitView`, but
that is not required for parity.

### The one real implementation cost

`BoardWorkItem` + the flattening logic (demote capability, interleave orphans,
client-side rail derivation) currently live in **`nexus-mac`'s `BoardModel.swift`**, not
in NexusShared. An iOS board needs either a lean iOS-side view model or (better) the
flatten logic hoisted into NexusShared. This is **bounded** — the *data* models it
consumes (`RoadmapCapability`/`RoadmapProposal`, `UnlinkedBead`) are already shared; only
the ~1 enum + the flatten/filter derivation would move or be re-expressed. No new
endpoints, no new decode paths, no new nav paradigm.

## Recommendation: **GO** (scoped)

The board maps onto nexus-ios's existing "tab → `NavigationStack` → value-typed
`.navigationDestination` → pushed detail" archetype with **zero new client wiring** (all
`all`-variant fetches + optional decodes already ship in NexusShared) and **zero new
navigation concepts** (it is one more instance of the Sessions-tab pattern, with
`BoardWorkItem` in the path slot instead of `String`). The only bounded cost is hoisting
or re-expressing the `BoardModel` flatten/filter derivation on the iOS side; everything it
depends on is already shared.

Schedule a follow-up spec to implement `RootTab.board` + `BoardScene` +
`BoardDetailScene`, with the first task being "hoist `BoardWorkItem` + flatten/rail-filter
into NexusShared" so Mac and iOS share one derivation. **No blocker found — proceed.**
