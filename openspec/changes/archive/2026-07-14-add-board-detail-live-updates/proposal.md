# Proposal: Add Board Detail Live Updates

## Change ID
`add-board-detail-live-updates`

## Summary
Rewire the board detail rail to bind an SSE connection to the currently-open proposal's owning
agent, so spec transitions (progress, status changes, completion) push into the view live instead
of requiring a manual refresh. This is a rewiring job, not a new build: the SSE endpoint
(`GET /specs/events`) and the Swift consumer (`NexusClient.consumeSpecEvents`) already exist,
already work, and are already spec-committed — they are simply unused dead code since the old
`SpecDetailView`/`SpecsView` were deleted (`refocus-board-shell` task 3.5).

## Motivation
`/openspec:explore` (2026-07-14) found that live spec-transition push was already built once, for
the pre-Swift Next.js dashboard, deliberately as SSE (the archived `add-spec-page-live-updates`
proposal explicitly scoped WebSocket out). That endpoint (`GET /specs/events`) survived the
migration to `nexus-mac` and is still committed in `spec-watcher/spec.md`, and the Swift client
method that consumes it (`NexusClient.consumeSpecEvents`) survived too — but the view that called
it was deleted during `refocus-board-shell` and the subscription was never re-added to the new
board's detail rail. The board currently only reflects a spec's true state on the next manual
selection or app relaunch.

## Context
- depends on: `add-board-detail-content-cache`
- touches: `apps/swift/NexusShared/Networking/NexusAggregateClient.swift`, `apps/swift/nexus-mac/Sources/Dashboard/BoardDetailRail.swift`
- `add-board-detail-content-cache` adds `SpecContentCache` and its
  `.cachedOnly` / `.fetchInFlight` / `.fresh(Date)` state model. This change treats a received
  `SpecTransition` event as a cache-invalidation signal that triggers the existing cache's
  revalidation fetch, rather than building a second, parallel data path.
- Extends: `apps/swift/nexus-mac/Sources/Dashboard/BoardDetailRail.swift` (open/close the SSE
  connection on proposal select/deselect)
- Extends: `apps/swift/NexusShared/Networking/NexusAggregateClient.swift` (resolve which single
  agent owns a project, reusing the existing fan-out-and-first-success pattern already used by
  `fetchSpecContent`, so the detail rail opens exactly one SSE connection instead of fanning a
  persistent stream out to every registered agent)
- No backend/agent changes: `GET /specs/events` (`apps/agent/src/routes/specs-events.ts`) already
  exists and is already spec-committed (`spec-watcher/spec.md`)
- Orphan beads: no per-item event exists server-side, only a project-level `BeadTransition`
  (aggregate ready/blocked counts) already flowing over the fleet-wide `GET /events/stream` that
  `SessionObserver` already subscribes to and already publishes as `lastBeadTransition`. Orphan
  live-refresh reuses that existing publisher — no new networking layer.
- Prior art: `openspec/specs/spec-watcher/spec.md` (the committed `GET /specs/events` contract);
  archived `openspec/changes/archive/2026-04-18-add-spec-page-live-updates/proposal.md`
  (WebSocket-vs-SSE decision precedent)

## Requirements

### Requirement: Detail rail binds a live SSE connection to an open proposal
When a proposal row is selected, the detail rail MUST open exactly one SSE connection
(`GET /specs/events`, filtered client-side to the selected project/slug) to the single agent that
owns the selected proposal's project. The connection MUST close when the selection changes to a
different item or is cleared. A received `SpecTransition` event matching the open item's
(project, slug) MUST invalidate the corresponding `SpecContentCache` entry and trigger its
existing revalidation fetch — the detail rail's rendering path is unchanged; only the trigger for
"refetch now" changes from "user reselects" to "server pushed a transition".

### Requirement: Owning-agent resolution for a persistent connection
`NexusAggregateClient` MUST expose a way to resolve which single registered agent owns a given
project (reusing the fan-out-and-first-success pattern `fetchSpecContent` already uses to find
the answering agent), so callers needing a persistent per-project connection do not have to
fan out N simultaneous streams across every registered agent.

### Requirement: Orphan detail live-refresh via existing BeadTransition
When an orphan bead row is selected, the detail rail MUST observe the owning `SessionObserver`'s
`lastBeadTransition` publisher and refetch/re-render the selected orphan's detail when a
transition arrives for its project. This reuses the existing fleet-wide event subscription;
no new per-bead event or networking path is introduced.

### Requirement: Reconnection on drop
The SSE connection MUST reconnect with exponential backoff on an unexpected drop, and MUST
trigger one revalidation fetch of the open item's cache entry immediately on reconnect (to catch
any transition missed while disconnected), matching the reconnect-then-refetch pattern already
established for this exact SSE contract in the archived `add-spec-page-live-updates` proposal.

## Scope
- **IN**: opening/closing one SSE connection per selected proposal; owning-agent resolution
  helper on `NexusAggregateClient`; reconciling `SpecTransition` events into the existing
  `SpecContentCache`; orphan live-refresh via the existing `lastBeadTransition` publisher;
  reconnect-with-backoff-then-refetch on drop
- **OUT**: a new WebSocket transport (already decided against — see prior art); per-bead
  server-side events (orphans use the existing coarser project-level signal); any change to the
  agent's `GET /specs/events` contract or coalescing window; multi-connection fan-out across
  agents for a single selection

## Impact
| Area | Change |
|------|--------|
| `apps/swift/NexusShared/Networking/NexusAggregateClient.swift` | New method resolving the single owning agent for a project (reuses `fetchSpecContent`'s fan-out-and-first-success logic) |
| `apps/swift/nexus-mac/Sources/Dashboard/BoardDetailRail.swift` | Opens/closes an SSE connection on proposal select/deselect via `NexusClient.consumeSpecEvents`; reconciles `SpecTransition` into `SpecContentCache`; observes `lastBeadTransition` for open orphans |

## Risks
| Risk | Mitigation |
|------|-----------|
| Connection churn from rapid row-clicking (open/close SSE per click) | Cancel the in-flight connection attempt immediately on deselection before it fully establishes; this mirrors the existing `Task` cancellation pattern already used elsewhere in the Swift client for per-selection async work |
| Reconnect loop hides a genuinely dead agent from the user | Cap backoff (matching the archived proposal's precedent) and surface the connection state via the cache-state indicator this change's dependency already added (`.cachedOnly` reads naturally as "not live" when the SSE connection is down) |
| Coalesced 5s server-side window means "live" has a real ceiling | Out of scope to change — this is the committed server contract (`spec-watcher/spec.md`); 5s is still a large improvement over "next manual reselect or app relaunch" |

## Testing
- Unit test: the owning-agent resolution helper returns the correct single agent given a
  multi-agent fixture (mirrors the existing `fetchSpecContent` fan-out test pattern).
- Unit test: a received `SpecTransition` for the currently-open (project, slug) invalidates and
  triggers revalidation of the matching `SpecContentCache` entry; a transition for a different
  (project, slug) is ignored.
- Unit test: deselecting a proposal (or selecting a different one) cancels the open SSE
  connection before a new one opens.
- Manual on-device verification is required (see `tasks.md` for the cited `[user]` task) — no
  existing CI/simulator harness exercises live SSE push against a real running agent
  (`nexus-mac-UITests` targets static fixtures); this genuinely needs a human watching the detail
  rail update while a proposal's `tasks.md` changes on disk on the owning machine.
