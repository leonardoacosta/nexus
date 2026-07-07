<!-- beads:epic:nx-0bhyl -->
<!-- beads:feature:nx-naeby -->

# Tasks: add-bead-proposal-roadmap-surface

> Sequencing: API Batch (agent services + wire types) lands first; UI Batch (Swift + statusline)
> consumes the wire contract. Within API, `bead-rollup.ts` is the shared primitive that
> `roadmap-aggregate.ts` and `beads-unlinked.ts` both reuse, so it lands first.

## DB Batch

_No database changes._ Rollups are computed live from `bd`; the statusline uses the existing
file cache, not a table (design.md § Non-goals).

## API Batch

- [x] 1.1 Add wire types to `packages/core/src/types/spec.ts`: `BeadRef`, `BeadRollup`, `UnlinkedBead` (per design.md § Aggregation); export from `packages/core/src/index.ts`. [owner:types-engineer] [type:feature] [beads:nx-0l9tz]
- [x] 1.2 Add `packages/core/src/types/roadmap.ts` with `RoadmapCapability` (design.md § Roadmap aggregation); export from `index.ts`. [owner:types-engineer] [type:feature] [beads:nx-hkks6]
- [x] 1.3 Create `apps/agent/src/services/bead-rollup.ts`: `collectLinkedBeadIds(projectPath)` (parse `beads:epic`/`beads:feature`/`[beads:id]` markers) and `computeBeadRollup(projectPath, specName)` (batched `bd list --id <csv> --json` via existing `execJson`, aggregate total/closed/ready/blocked; ready = intersect `bd ready --json`; blocked = status or unclosed `blocks` dep). Never throw — return `null` on bd failure, mirroring `fetchBeadsSummary`. [owner:api-engineer] [type:feature]
- [x] 1.4 Create `apps/agent/src/services/roadmap-aggregate.ts`: enumerate `[CAPABILITY]` epics (`bd list --type epic --json`), resolve each child feature bead's `spec_id` via `bd show <id> --json`, reuse `computeBeadRollup`, aggregate per-capability progress -> `RoadmapCapability[]`. [owner:api-engineer] [type:feature] [beads:nx-xjviu]
- [x] 1.5 Create `apps/agent/src/routes/beads-unlinked.ts` (`GET /beads/unlinked?project=`): open+in_progress beads minus `collectLinkedBeadIds` union across live proposals -> `{ unlinked: UnlinkedBead[] }`. [owner:api-engineer] [type:feature] [beads:nx-q3jnp]
- [x] 1.6 Create `apps/agent/src/routes/roadmap.ts` (`GET /roadmap?project=`) delegating to `roadmap-aggregate.ts`. [owner:api-engineer] [type:feature] [beads:nx-84twr]
- [x] 1.7 Extend `apps/agent/src/routes/specs.ts`: attach `beadRollup` to `handleGetSpec`; replace the count-only `beads` field in `handleGetSpecsAll`/`fetchBeadsSummary` with `computeBeadRollup`. [owner:api-engineer] [type:feature] [beads:nx-ouzak]
- [x] 1.8 Register `/beads/unlinked` and `/roadmap` in `apps/agent/src/server-request-handler.ts` alongside the existing `/specs*` dispatch. [owner:api-engineer] [type:feature] [beads:nx-qplzy]
- [x] 1.9 Bun unit test `apps/agent/src/services/bead-rollup.test.ts`: a `tasks.md` fixture with epic/feature/task markers + a mocked `bd list --id` result asserts aggregated counts, epic/feature resolution, and the missing-bead (bd returns fewer rows) + empty-markers edge cases. [owner:test-writer] [type:test] [beads:nx-7pagf]
- [x] 1.10 Bun unit test `roadmap-aggregate.test.ts` (capability -> proposals progress; feature bead pointing at an archived proposal is classified not dropped) and `beads-unlinked.test.ts` (referenced beads excluded, ad-hoc bead included). [owner:test-writer] [type:test] [beads:nx-oukmf]
- [x] 1.11 Extend `apps/agent/src/routes/specs.test.ts` and add `roadmap.test.ts`/`beads-unlinked.test.ts`: HTTP 200 payload shape matches the core wire types (follow `specs-payload-completeness.test.ts`). [owner:test-writer] [type:test] [beads:nx-h4yqw]

## UI Batch

- [x] 2.1 Add `apps/swift/NexusShared/Models/BeadRollup.swift` (`BeadRollup`, `BeadRef`, `UnlinkedBead` Codable; non-optional counts per the `specs.ts:167` wire discipline) and `apps/swift/NexusShared/Models/Roadmap.swift` (`RoadmapCapability`). [owner:swift-engineer] [type:feature] [beads:nx-iqekj]
- [x] 2.2 Extend `apps/swift/NexusShared/Models/SpecSummary.swift` with an optional `beadRollup`; add `fetchUnlinkedBeads(project:)` + `fetchRoadmap(project:)` and decode the new field in `fetchSpec` in `apps/swift/NexusShared/Networking/NexusClient.swift`. [owner:swift-engineer] [type:feature] [beads:nx-baivc]
- [x] 2.3 `apps/swift/nexus-mac/Sources/Dashboard/SpecsView.swift`: per-proposal progress bar (`closed/total`) + ready-count chip + tappable epic/feature ids; add an "Unlinked open beads" section fed by `fetchUnlinkedBeads`. [owner:swift-engineer] [type:feature] [beads:nx-ljcq2]
- [x] 2.4 `apps/swift/nexus-mac/Sources/Dashboard/SpecDetailView.swift`: add a "Beads" section listing `rollup.beads` with a status glyph (reuse the existing session/spec status-glyph convention). [owner:swift-engineer] [type:feature] [beads:nx-zhhpd]
- [x] 2.5 Add `apps/swift/nexus-mac/Sources/Dashboard/RoadmapView.swift`: `List` of capabilities as `DisclosureGroup`s of proposals with per-proposal + per-capability progress bars; register the Roadmap tab in `apps/swift/nexus-mac/Sources/AppNavigation.swift`; run `cd apps/swift && xcodegen generate`. [owner:swift-engineer] [type:feature] [beads:nx-2n3ka]
- [x] 2.6 `apps/nexus-statusline/src/index.ts`: add a specs line (top in-progress proposal `x/total . N ready`) and a roadmap line (least-complete capability) behind the existing stale-while-revalidate file cache (the `getRoadmapPulse()` shape); empty on first render. [owner:api-engineer] [type:feature] [beads:nx-tibp5]
- [x] 2.7 `apps/swift/nexus-mac/Tests/SpecsViewTests.swift` + new `RoadmapViewTests.swift`: the Codable models decode a fixture agent payload without throwing; rollup count fields present. [owner:swift-engineer] [type:test] [beads:nx-sipek]

## E2E Batch

- [x] 3.1 Build gate MET: `bun test` green for agent+core (paste the bead-rollup/roadmap/unlinked test stdout); `xcodebuild -scheme nexus-mac` typecheck via the `ssh mac` headless contract (swift `-typecheck` where GUI signing is unavailable). This is the runtime evidence for the wire contract. [owner:e2e-engineer] [type:test] [beads:nx-e48rm]
- [x] 3.2 Runtime check: `curl -s localhost:7400/specs/nx/ios-session-navigation | jq .beadRollup` and `curl -s 'localhost:7400/roadmap?project=nx' | jq '.capabilities[0]'` against the running homelab agent return populated rollups (paste the JSON). [owner:e2e-engineer] [type:test] [beads:nx-tul1n]
- [ ] 3.3 [user] On-device visual check (needs Nexus.app rebuilt on the Mac; GUI signing is gated per reference_mac_swift_deploy — searched: apps/swift build docs + reference_mac_swift_deploy memory; no documented pattern renders a signed GUI dashboard headlessly): the Specs tab shows proposal progress bars + the Unlinked beads section, and the Roadmap tab renders capabilities with progress. [owner:user] [type:test] [beads:nx-hce7u]
