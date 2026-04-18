# Implementation Tasks

<!-- beads:epic:nx-s9p8 -->

## API Batch

- [x] [1.1] [P-1] Audit call sites: grep consumers of spec-watcher exports (startSpecWatcher, parseSpecList, _projectState, _getWatchDegradedForTest) to enumerate the public API that must remain importable [owner:api-engineer] [beads:nx-ntyu]
- [x] [1.2] [P-2] Create apps/agent/src/services/spec-watcher/ directory; move constants into constants.ts (local — peer-connector and cron have no overlapping constants, promotion to @nexus/core not warranted) [owner:api-engineer] [beads:nx-sfvv]
- [x] [1.3] [P-2] Extract pure parser into spec-watcher/parser.ts: parseSpecList, readProposalHash, processProjectSpecs, eventToMessage, SpecSnapshot type — no spawn, no fs.watch, no TTS, no network [owner:api-engineer] [beads:nx-1fus]
- [x] [1.4] [P-2] Extract poller into spec-watcher/poller.ts: pollProjectSpecs, loadProjectRegistry, and any subprocess helpers; thread projectState in via function argument rather than module-level import [owner:api-engineer] [beads:nx-5akg]
- [x] [1.5] [P-2] Extract file watcher into spec-watcher/watcher.ts: activeWatchers, watchDegraded, pendingSpecRefresh, refreshSingleSpec, startChangesFsWatchers, _getWatchDegradedForTest [owner:api-engineer] [beads:nx-27y9]
- [x] [1.6] [P-2] Extract TTS dispatch into spec-watcher/tts.ts: sendSpecTtsNotification [owner:api-engineer] [beads:nx-1r7o]
- [x] [1.7] [P-3] Convert apps/agent/src/services/spec-watcher.ts into spec-watcher/index.ts: lifecycle only (SpecWatcherService interface, startSpecWatcher, projectState Map, delay helper); re-export full public API for backward compat [owner:api-engineer] [beads:nx-rkhr]
- [x] [1.8] [P-3] Extract helpers from refreshSingleSpec and pollProjectSpecs to cap nesting at 3 levels; do NOT change logic, conditions, or timing values during extraction [owner:api-engineer] [beads:nx-vvei]
- [x] [1.9] [P-4] Run pnpm turbo run build --filter=@nexus/agent && pnpm --filter @nexus/agent test — all green [owner:api-engineer] [beads:nx-o32v]

## E2E Batch

- [x] [2.1] Add line-count assertion test (or ESLint rule) asserting each spec-watcher/*.ts file is ≤250 lines [owner:e2e-engineer] [beads:nx-5q0m]
- [x] [2.2] Add unit test for parseSpecList + processProjectSpecs in spec-watcher/parser.test.ts that does NOT spawn subprocesses (proves parser is pure) [owner:e2e-engineer] [beads:nx-vj4b]
