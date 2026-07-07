---
capability: bead-proposal-roadmap
status: draft
---

# Surface the bead <-> proposal <-> roadmap join

## Why

nx already surfaces OpenSpec proposals (`apps/agent/src/routes/specs.ts`) and `spec-sync`
already writes the bead->proposal link on every synced bead (`bd create ... --spec-id <slug>`,
verified bd 1.0.3: `bd show <id> --json` reads `spec_id` back). But nothing surfaces the join
in the other direction: given a proposal, nx cannot show *which beads implement it and their live
status*; and there is no capability-level roadmap. The only bead surface today is
`fetchBeadsSummary` in `specs.ts` — a per-project ready-count with `closed` hard-coded to `0`.

External recon (`docs/recon/beadboard.md`, `docs/recon/beads-task-issue-tracker.md`) confirmed
two mature Beads dashboards solve bead *visualization* well but neither links to a proposal system.
nx's `spec_id` write-side is already done; the defensible surface is the **read half** — proposal
progress rollups, unlinked-bead visibility, and a capability-epic roadmap — which becomes nx's
"bread and butter."

This is purely additive: no bd writes, no schema migration. Rollups are computed live from `bd`
(the CLI stays the only writer — the discipline recon stole from beadboard's null-safe read path).

## What Changes

- **Bead rollup per proposal** (agent): parse the `<!-- beads:epic -->` / `<!-- beads:feature -->`
  / `[beads:xxx]` markers `spec-sync` already writes into `tasks.md`, batch-resolve live state via
  one `bd list --id <csv> --json`, and aggregate into a `BeadRollup` (epic/feature status, tasks
  total/closed/ready/blocked). Attach to `GET /specs/:project/:name` and `GET /specs/all`.
- **Unlinked (orphan) beads** (agent): `bd list --status open,in_progress --json` minus the union
  of all bead IDs referenced by any live proposal's `tasks.md` = open work tied to no proposal.
  New `GET /beads/unlinked?project=` endpoint.
- **Capability roadmap** (agent): enumerate `[CAPABILITY]` epics (`bd list --type epic --json`),
  map each child feature bead to its proposal via `spec_id`, roll each proposal's `BeadRollup` up
  to a per-capability progress figure. New `GET /roadmap?project=` endpoint.
- **Wire types** (`packages/core`): `BeadRollup`, `UnlinkedBead`, `RoadmapCapability` +
  extend `SpecSummary`/spec-detail payloads. Mirror in NexusShared Codable models.
- **Swift Specs tab**: proposal rows gain a progress bar + ready chip + tappable epic/feature;
  detail view lists the linked beads with live status; a new "Unlinked open beads" section.
- **Swift Roadmap tab** (new): capability -> proposals -> progress, wired into `AppNavigation.swift`.
- **Statusline**: add a specs line (`ios-session-nav 14/15 . 1 ready`) and a roadmap line, using
  the existing stale-while-revalidate cache shape.

## Context

- touches: `apps/agent/src/routes/specs.ts`, `apps/agent/src/services/bead-rollup.ts`, `apps/agent/src/services/roadmap-aggregate.ts`, `apps/agent/src/routes/roadmap.ts`, `apps/agent/src/routes/beads-unlinked.ts`, `apps/agent/src/server-request-handler.ts`, `packages/core/src/types/spec.ts`, `packages/core/src/types/roadmap.ts`, `packages/core/src/index.ts`, `apps/swift/NexusShared/Models/SpecSummary.swift`, `apps/swift/NexusShared/Models/BeadRollup.swift`, `apps/swift/NexusShared/Models/Roadmap.swift`, `apps/swift/NexusShared/Networking/NexusClient.swift`, `apps/swift/nexus-mac/Sources/Dashboard/SpecsView.swift`, `apps/swift/nexus-mac/Sources/Dashboard/SpecDetailView.swift`, `apps/swift/nexus-mac/Sources/Dashboard/RoadmapView.swift`, `apps/swift/nexus-mac/Sources/AppNavigation.swift`, `apps/nexus-statusline/src/index.ts`

## Testing

- **Bead rollup service** — Bun unit test (`bead-rollup.test.ts`): given a `tasks.md` fixture with
  epic/feature/task markers and a mocked `bd list --id` result, asserts the aggregated
  total/closed/ready/blocked counts and epic/feature status resolution. Covers the empty-markers
  and stale-bead-id (bd returns fewer rows than requested) edge cases.
- **Roadmap aggregation** — Bun unit test (`roadmap-aggregate.test.ts`): capability epics with
  child features mapped to proposals produce correct per-capability progress; a feature bead with a
  `spec_id` pointing at an archived proposal is classified, not dropped.
- **Unlinked beads** — Bun unit test: open beads not referenced by any proposal `tasks.md` are
  returned; referenced beads are excluded.
- **Route contracts** — extend `apps/agent/src/routes/specs.test.ts` + new
  `roadmap.test.ts`/`beads-unlinked.test.ts`: HTTP 200 payload shape matches the core wire types
  (the payload-completeness pattern already used by `specs-payload-completeness.test.ts`).
- **Swift decode** — `SpecsViewTests`/new `RoadmapViewTests`: the Codable models decode the agent
  payload (fixture JSON) without throwing; non-optional rollup fields present.
- **Build gate (runtime evidence)** — `bun test` green for agent+core; `xcodebuild -scheme
  nexus-mac` typecheck via the headless `ssh mac` contract (swift `-typecheck` where GUI signing
  is unavailable). E2E user task: rendered Specs/Roadmap tabs against a live homelab agent.

## Impact

- Affected specs: new capability `bead-proposal-roadmap`.
- Affected code: `apps/agent` (routes + 3 services), `packages/core` (wire types), `apps/swift`
  (NexusShared models + client, mac Specs/Roadmap views + tab), `apps/nexus-statusline`.
- No DB migration (rollups computed live; statusline uses a file cache, not a table).
- No breaking changes: `fetchBeadsSummary`'s existing count field stays until the Swift rollup
  lands, then is replaced (clean replacement, no back-compat layer).
