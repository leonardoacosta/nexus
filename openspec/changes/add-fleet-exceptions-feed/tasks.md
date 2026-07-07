# Tasks — add-fleet-exceptions-feed

## API Batch

- [ ] 1.1 Port beadboard's bead reader into `apps/agent/src/lib/beads-reader.ts` (MIT attribution header citing jordanhindo/beadboard src/lib/read-issues-dolt.ts + parser.ts): Dolt two-query primary with metadata.json/dolt-server.port discovery, issues.jsonl parse fallback, null-not-throw contract (searched: no existing beads reader anywhere in nx/agent; beadboard's is the debugged exemplar per docs/recon/beadboard.md)
  - touches: apps/agent/src/lib/beads-reader.ts
- [ ] 1.2 Exceptions computation `apps/agent/src/lib/fleet-exceptions.ts`: walk ~/dev/*/.beads, classes P0/P1-open, in_progress>7d, ready-head>30d, unarchived openspec/changes count; skipped-entry for missing/corrupt stores; payload entries capped at 3 offender ids
  - depends on: 1.1
  - touches: apps/agent/src/lib/fleet-exceptions.ts
- [ ] 1.3 `GET /exceptions` route: SWR cache (5min TTL, detached background refresh — mirror the roadmap-pulse cache shape), fail-soft empty-200
  - depends on: 1.2
  - touches: apps/agent/src/routes/exceptions.ts, apps/agent/src/server-request-handler.ts
- [ ] 1.4 Tests: fixture .beads dirs (JSONL-only path, corrupt store skipped, clean fleet -> empty array), class thresholds, cache staleness, offender cap
  - depends on: 1.3
  - touches: apps/agent/src/lib/fleet-exceptions.test.ts, apps/agent/src/routes/exceptions.test.ts

## UI Batch

- [ ] 2.1 NexusShared: `FleetExceptions` Codable model + observer polling /exceptions (existing observer cadence conventions)
  - depends on: 1.3
  - touches: apps/swift/NexusShared/Models/, apps/swift/NexusShared/Observers/
- [ ] 2.2 nexus-mac: menubar exceptions section — renders ONLY when exceptions non-empty (absent on clean feed, asserted in review); repo/class/count/offender-ids text lines, no scroll, no drill-in
  - depends on: 2.1
  - touches: apps/swift/nexus-mac/
- [ ] 2.3 apps/web: one exceptions row on /radar, hidden when clean, same shape-not-items rule
  - depends on: 1.3
  - touches: apps/web/src/app/radar/

## E2E Batch

- [ ] 3.1 Headless swift typecheck gate (xcodegen + swiftc -typecheck via ssh contract) + agent vitest suite green; paste output
  - depends on: 2.2, 2.3
- [ ] 3.2 Runtime evidence: `GET /exceptions` against the real ~/dev fleet — paste the payload; confirm current known exceptions (e.g. stale in_progress claims found in the 2026-07-07 audit) appear and clean repos do not
  - depends on: 3.1
