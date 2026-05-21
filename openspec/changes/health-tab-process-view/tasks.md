# Tasks: health-tab-process-view

<!-- beads:epic:nx-68ssl -->
<!-- beads:feature:nx-6l5xw -->

## API Batch

- [x] 1.1 Extend `ProcessInfo` in `packages/core/src/types/health.ts` with optional `command: string | null`, `user: string | null`, `state: string | null`. Keep existing `pid`, `name`, `cpu_percent`, `ram_percent` unchanged. [beads:nx-qof4a]
- [x] 1.2 Extend `topN()` in `apps/agent/src/health-collector.ts` to map `command`, `user`, `state` from `systeminformation`'s `ProcessesProcessData`. Truncate `command` at 200 chars + ellipsis when over. [beads:nx-ixee6]
- [x] 1.3 Extend `apps/agent/src/health-collector.test.ts` to cover the new fields: `command` populated end-to-end, truncation at 200 chars, missing-field tolerance (mock a stripped systeminformation row). [beads:nx-bryyt]
- [x] 1.4 Add `apps/agent/src/routes/health-processes.ts` exporting `handleHealthProcesses(url, state)`. Reads `state.healthCollector.getLatest()`; returns `{ top_cpu, top_ram, collectedAt: latest?.collectedAt ?? null }` with limit applied. Validates `?limit=` integer 1..50; default 10. Bad limit returns `400 { error }`. [beads:nx-6fz85]
- [x] 1.5 Register the route in `apps/agent/src/server-request-handler.ts` BEFORE the catch-all paths. Add the GET method match and pass-through to `handleHealthProcesses`. Update the route inventory comment block. [beads:nx-ah4fp]
- [x] 1.6 Add `apps/agent/src/routes/health-processes.test.ts` covering each scenario from `specs/health-timeseries/spec.md` (default limit, explicit limit, limit out of range 400, collector warming up 200 with empties). [beads:nx-zqnqk]
- [x] 1.7 Extend `apps/swift/NexusShared/Models/ProcessInfo.swift` (or wherever the Swift mirror lives) with optional `command: String?`, `user: String?`, `state: String?`. Existing fields unchanged. Add a unit test in `NexusSharedTests` confirming decode for both old (3-field) and new (6-field) payload shapes. [beads:nx-yzqz2]
- [x] 1.8 Extend `apps/swift/NexusShared/Networking/NexusClient.swift` with `fetchHealthProcesses(machine: String?, limit: Int)` returning `HealthProcessesResponse`. Decoder accepts optional `collectedAt: Date?`. Add same to `NexusAggregateClient.swift` via the existing per-machine fan-out pattern. **Conflict: shared file with specs-tab-start-on-spec and projects-tab-accordion-deeplink — wave-plan-build will serialize.** [beads:nx-kb59t]

## UI Batch

- [ ] 2.1 Add `apps/swift/nexus-mac/Sources/Dashboard/ProcessTableView.swift` — two-column `HStack` (top CPU left, top RAM right) with `ScrollView` per column. Per-row: PID (monospace), name (bold), user (caption), command (caption, line-limit 1), and a `ProgressView` styled as a percentage bar in the row's metric color (CPU = blue, RAM = orange). Numeric-uid prefix: if `user` matches `^[0-9]+$`, render `uid:<value>`. [beads:nx-0e1me]
- [ ] 2.2 Wire `ProcessTableView` into `apps/swift/nexus-mac/Sources/Dashboard/HealthView.swift` BELOW the existing CPU/RAM/Disk charts (not replacing them). Pass `model.processes` from a new view-model property. Hide the section entirely when both lists are empty (warming-up case). [beads:nx-spzsj]
- [ ] 2.3 Add `processes: HealthProcessesResponse?` + `loadProcesses()` to `HealthViewModel`. Auto-refresh every 5 seconds via a Task loop while the view is on screen; cancel on disappear. Same `machine: String?` parameter the time-series uses. [beads:nx-o6uiy]
- [ ] 2.4 Implement the stale-snapshot grey-out: compute `Date().timeIntervalSince(collectedAt) > 30` and apply `.opacity(0.5)` to ProcessTableView when stale, with a `Text("snapshot stale — last tick \(formattedAge) ago")` caption above the columns. Use a `TimelineView` so the staleness re-evaluates without re-fetching. [beads:nx-6h7st]
- [ ] 2.5 Wire the machine selector so switching machines clears `processes` to nil first, then re-fetches — prevents flashing the previous machine's processes while the new fetch is in flight. [beads:nx-8yhnz]
- [ ] 2.6 Add `apps/swift/nexus-mac/Sources/Dashboard/ProcessTableViewTests.swift` covering: populated rendering, empty hide-section, uid-prefix numeric user, stale grey-out toggle at 30s boundary. [beads:nx-jy4uh]

## E2E Batch

- [ ] 3.1 End-to-end: curl `GET /health/processes?limit=5` against the local agent, assert response shape (`top_cpu`, `top_ram`, `collectedAt`), assert at least one row has `command` populated, assert numeric `pid` and float `cpu_percent`. [beads:nx-osjcf]
- [ ] 3.2 End-to-end: curl `GET /health/processes?limit=51` against local agent, assert response is `400 { error: "limit must be 1..50" }`. [beads:nx-ss2q7]
- [ ] 3.3 End-to-end: deploy agent to homelab, curl `GET /health/processes?limit=20`, paste output. Confirm the snapshot includes the production CC + nexus-agent processes (sanity check the lib's process enumeration works on Linux). [beads:nx-qco3b]
- [ ] 3.4 [user] Open Nexus.app Health tab on Mac. Confirm: (a) two-column process table renders below the charts; (b) machine selector switches both charts AND processes; (c) bars visualise CPU/RAM%; (d) when homelab is slow to respond, the previous data is cleared (no flash); (e) leave the tab open >30s and observe the stale-snapshot grey-out if the collector falls behind. [beads:nx-p6gjm]
