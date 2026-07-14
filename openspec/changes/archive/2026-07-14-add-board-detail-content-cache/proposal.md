# Proposal: Add Board Detail Content Cache

## Change ID
`add-board-detail-content-cache`

## Summary
Add an in-memory, stale-while-revalidate cache for the board's detail-rail spec content
(proposal/design/tasks markdown), plus eager background prefetch for visible proposal rows and a
small cache-state indicator in the detail rail. Fixes the "app feels laggy" symptom: every row
click and every tab switch today triggers a cold network fetch with a blocking spinner.

## Motivation
`BoardDetailModel.loadContent()` calls `NexusAggregateClient.fetchSpecContent` fresh on every
selection and every proposal/design/tasks tab switch. `NexusAggregateClient` has no caching layer
anywhere in the codebase (confirmed by inspection — the only "cache" reference is an unrelated
MP3-notification comment). Task/dependency rollups are unaffected (they arrive inline with the
initial roadmap payload); only spec markdown content is the cold-fetch-per-click cost. Rendering
cached content instantly while a background refresh runs — and eagerly warming the cache for
rows already visible on screen — removes the dominant source of perceived lag without touching the
backend.

## Context
- Extends: `apps/swift/nexus-mac/Sources/Dashboard/BoardDetailRail.swift` (`BoardDetailModel`)
- Extends: `apps/swift/nexus-mac/Sources/Dashboard/BoardView.swift`, `BoardModel.swift`
  (`BoardViewModel`) — prefetch trigger on `visibleItems` change
- New: a small cache type under `apps/swift/nexus-mac/Sources/Dashboard/` (name TBD in tasks,
  e.g. `SpecContentCache.swift`)
- Related capability: `project-structure-board` (this change amends its existing "Detail rail"
  requirement — does not replace it; the underlying fetch, `GET /specs/:project/:name/:file`,
  is unchanged)
- Prior exploration: `/openspec:explore` session 2026-07-14 — confirmed zero existing caching
  layer, confirmed task/dep rollups are out of scope, confirmed no spec conflict
- Companion change (not yet scaffolded, depends on this one's cache/state model): rewiring the
  existing-but-unused `GET /specs/events` SSE plumbing (`NexusClient.consumeSpecEvents`, already
  implemented, zero call sites) for live updates on the currently-open item

## Requirements

### Requirement: In-memory stale-while-revalidate cache for spec content
The board detail rail MUST cache spec markdown content (proposal/design/tasks) in memory, keyed
by (project, slug, file). On selection, if a cache entry exists, its content MUST render
immediately while a background refetch runs; the rendered content MUST update in place when the
refetch completes. The cache MUST be session-scoped (in-memory only, no persistence) — it is
naturally cleared on app relaunch, no eviction policy or TTL beyond "always revalidate on
selection" is required for this change.

### Requirement: Eager background prefetch for visible rows
When the board's visible item list changes (filter, sort, or project selection), the board MUST
kick off bounded background prefetches for the DEFAULT tab (`proposal.md`) of the first N visible
proposal rows (N = 20, in-order — not true scroll-viewport tracking). Design and tasks tabs are
NOT eagerly prefetched; they populate the cache on first on-demand fetch like today. Prefetch
requests MUST NOT block the UI and MUST silently no-op (not retry-storm) on failure.

### Requirement: Cache-state indicator in the detail rail
The detail rail MUST show a small, unobtrusive indicator of the currently-selected item's spec
content cache state: cached-only (rendering stale/prefetched content, no live fetch yet resolved
this session), fetch-in-flight (a request is currently running), or fresh (the visible content
reflects the most recent successful fetch, with a relative timestamp). The indicator lives in the
detail rail only — not on individual board rows.

## Scope
- **IN**: in-memory cache keyed by (project, slug, file); stale-while-revalidate render-then-refresh
  on selection; bounded eager prefetch of the default tab for the first 20 visible proposal rows;
  cache-state indicator in the detail rail
- **OUT**: per-row cache-state indicators on the board list; live push updates via SSE/WebSocket
  (companion change, not this one); persisting the cache to disk; a configurable TTL/eviction
  policy; prefetching design/tasks tabs; any backend/agent changes (the underlying
  `GET /specs/:project/:name/:file` fetch is unchanged)

## Impact
| Area | Change |
|------|--------|
| `apps/swift/nexus-mac/Sources/Dashboard/SpecContentCache.swift` | New — in-memory cache keyed by (project, slug, file), fetch-state enum, actor-isolated for concurrency safety |
| `apps/swift/nexus-mac/Sources/Dashboard/BoardDetailRail.swift` | `BoardDetailModel` reads/writes the cache instead of fetching directly; renders cached content immediately + revalidates; new cache-state indicator view |
| `apps/swift/nexus-mac/Sources/Dashboard/BoardView.swift` / `BoardModel.swift` | Trigger bounded prefetch of the first 20 visible proposal rows' `proposal.md` on `visibleItems` change |

## Risks
| Risk | Mitigation |
|------|-----------|
| Prefetch storm on a fleet with thousands of rows (the board's "Unregistered" bucket can hold thousands of orphans) | Bound prefetch strictly to proposal rows (not orphans, which have no spec content) and cap at the first 20, in list order |
| Cache goes stale silently if a spec changes while cached content is displayed | Out of scope for this change by design — the companion SSE change addresses live invalidation; this change's baseline behavior (always revalidate on selection) is a strict improvement over today's zero-cache baseline |
| Actor/concurrency bugs in the new cache type under rapid row-clicking | Use Swift's `actor` isolation for the cache type; write a focused unit test exercising rapid sequential selections |

## Testing
- Unit test: `SpecContentCache` returns cached content synchronously-available on second read,
  correctly transitions `.cachedOnly` → `.fetchInFlight` → `.fresh(Date)`, and tolerates rapid
  concurrent selection changes without data races (actor isolation).
- Unit test: `BoardViewModel`'s prefetch trigger requests exactly the first 20 visible proposal
  rows' `proposal.md` (not orphans, not design/tasks tabs) when `visibleItems` changes, and does
  not re-request rows already cached and fresh.
- Manual/on-device verification (headless Mac build gate, per `swift-engineer`'s standard
  contract): confirm the detail rail renders cached content instantly on re-selecting a
  previously-opened proposal, and that the cache-state indicator transitions through all three
  states visibly.
