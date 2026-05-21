# Tasks: specs-tab-accordion-with-topology

<!-- beads:epic:nx-jfd9i -->
<!-- beads:feature:nx-x9tf3 -->

## API Batch

- [x] [1.1] Create `apps/agent/src/routes/wave-plans.ts` with `handleGetActiveWavePlan(): Promise<Response>`. Reads `docs/apply/active.txt` from the agent's repo root (resolve via existing project-registry or env). Parses `docs/apply/<run-id>/wave-plan.json`. Projects per-spec status into the documented wire shape. Returns 200 with `{runId, planName, status, currentWave, currentPhase, specStatuses: []}` on success; empty payload on missing active.txt; error-embedded payload on malformed JSON [owner:api-engineer] [type:feature] [beads:nx-68qqu]
- [x] [1.2] [P-1] Add route dispatch in `apps/agent/src/server-routes-wave-plans.ts` (NEW) matching `GET /wave-plans/active`. Wire into the main request handler via the existing `LEGACY_DISPATCH_ROUTES` or per-domain dispatcher pattern [owner:api-engineer] [type:feature] [beads:nx-ncgel]
- [x] [1.3] [P-1] Wire `tryHandleWavePlanRoute` into `apps/agent/src/server-request-handler.ts` route table [owner:api-engineer] [type:feature] [beads:nx-6xhkf]
- [x] [1.4] Spec status normalization helper: internal wave-plan json may use `dispatched`/`pending`/`done` — map to canonical wire enum `queued|dispatched|in_progress|completed|failed|skipped` (mirror what /apply already uses for telemetry). Unknown → `queued` fallback [owner:api-engineer] [type:feature] [beads:nx-rm21h]
- [x] [1.5] Add `apps/agent/src/routes/wave-plans.test.ts` with 5 tests: valid active plan returns projection, no active.txt returns empty payload, malformed JSON returns error-embedded payload, status enum normalization, current wave inference [owner:api-engineer] [type:test] [beads:nx-9nxvf]

## UI Batch

- [x] [2.1] Create `apps/swift/NexusShared/Models/WavePlanStatus.swift` — Codable structs mirroring the agent's wire shape: `WavePlanStatus`, `SpecStatus`. Use camelCase CodingKeys (wire uses camelCase). Add helper computed properties: `isActive: Bool` (runId != nil), `lookupSpec(name:) -> SpecStatus?` [owner:ui-engineer] [type:types] [beads:nx-5qker]
- [x] [2.2] [P-1] Add `fetchWavePlanStatus() async -> WavePlanStatus?` to `apps/swift/NexusShared/Networking/NexusClient.swift` and `apps/swift/NexusShared/Networking/NexusAggregateClient.swift`. Returns nil on transport error; returns empty payload on 200 with `runId: null` [owner:ui-engineer] [type:feature] [beads:nx-ihhyh]
- [x] [2.3] Update `SpecsView`/`SpecsViewModel` to fetch wave plan on `.task` mount alongside the existing specs fetch. Store in `@Published var wavePlan: WavePlanStatus?`. Refresh on the same cadence as specs SSE updates (or on manual pull-to-refresh — whichever is wired today) [owner:ui-engineer] [type:feature] [beads:nx-kiton]
- [x] [2.4] [P-2] Restructure `apps/swift/nexus-mac/Sources/Dashboard/SpecsView.swift` to use `DisclosureGroup` per project group. Persist expansion state via UserDefaults keyed by `specsAccordion.<slug>`, default collapsed. Replace the existing always-expanded `Section` blocks [owner:ui-engineer] [type:feature] [beads:nx-z2il2]
- [x] [2.5] [P-2] Project header: render slug, completion summary (e.g. `3/8 active`), and an active-session pulsing green dot when at least one active session matches the project (cross-reference SessionObserver's session list by cwd path or gitOwnerRepo). Add tooltip with session count [owner:ui-engineer] [type:feature] [beads:nx-3s5cu]
- [x] [2.6] [P-3] Project header: when the active wave plan touches any spec in this project, render a wave rollup chip on the header (e.g. `[W2 · 1 dispatched]`). Hidden when no active wave plan [owner:ui-engineer] [type:feature] [beads:nx-hqeqy]
- [x] [2.7] [P-3] Spec row enrichment: when the spec is in the active wave plan, render a `[W2]` chip after the progress bar AND a colored status dot (gray queued / blue in_progress / green completed / red failed). Pulsing animation only on in_progress [owner:ui-engineer] [type:feature] [beads:nx-fasin]

## E2E Batch

- [ ] [3.1] Add `apps/swift/NexusSharedTests/WavePlanStatusTests.swift` — 3 tests: testDecodesFullPayload, testDecodesEmptyPayload (runId nil), testLookupSpecReturnsNilForMissing [owner:ui-engineer] [type:test] [beads:nx-g94wu]
- [ ] [3.2] Push + ssh-pull homelab — verify `/wave-plans/active` returns valid JSON via Tailscale curl. If no active run on homelab, response should be `{runId: null, specStatuses: []}`. Capture stdout [owner:devops-engineer] [type:test] [beads:nx-22u0o]
- [ ] [3.3] Mac post-merge rebuild via `deploy/hooks.d/post-merge/04-swift-deploy --force`. Force-kill old PID + relaunch (nx-4l66v hook bug workaround). Verify rebuild via PID change [owner:devops-engineer] [type:test] [beads:nx-ssksd]
- [ ] [3.4] [user] Open Nexus.app Specs tab: (a) confirm accordions are collapsed by default; (b) expand one project, confirm specs render with progress bars; (c) verify active-session dot appears on project headers with running CC sessions in their dir; (d) if any /apply is running, confirm wave chips appear. Capture screenshot [user] [owner:user] [type:test] [beads:nx-8tdzd]
- [ ] [3.5] Update `openspec/specs/spec-watcher/spec.md` AND `openspec/specs/swift-menubar-client/spec.md` post-archive [handled by Phase 4 archive] [owner:devops-engineer] [type:docs] [beads:nx-bdycd]
