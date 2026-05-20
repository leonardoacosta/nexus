# Tasks: dashboard-ui-pass-v1

<!-- beads:epic:nx-rxlbi -->
<!-- beads:feature:nx-yckkw -->

## API Batch

- [x] [1.1] Add `GET /specs/{project}/{name}/{file}` route to `apps/agent/src/routes/specs.ts`. file ∈ {proposal, design, tasks}. Resolve path via spec-watcher's `resolveRoots()` config + path sanitization (reject `..` and absolute paths; only allow `<root>/<project>/openspec/changes/<spec>/<file>.md`). Return 200 with `Content-Type: text/markdown; charset=utf-8` on success, 400 on traversal, 404 on missing file [owner:api-engineer] [type:feature] [beads:nx-u002i]
- [x] [1.2] [P-1] Wire route into `apps/agent/src/server-request-handler.ts` — pattern-match `/specs/{a}/{b}/{c}` GET, delegate to new handler [owner:api-engineer] [type:feature] [beads:nx-776hz]
- [x] [1.3] [P-1] Add `apps/agent/src/routes/specs.test.ts` tests for the new endpoint: valid proposal fetch, valid design fetch, 404 on missing file, 400 on `..` traversal, 400 on missing query params [owner:api-engineer] [type:test] [beads:nx-3kwsg]

## UI Batch

- [x] [2.1] Add `fetchSpecContent(project: String, name: String, file: String) async -> String?` to `apps/swift/NexusShared/Networking/NexusClient.swift`. Returns markdown string or nil on 404. Use the existing `session` (not streamingSession). Add aggregate method in NexusAggregateClient that picks the first agent's response [owner:ui-engineer] [type:feature] [beads:nx-4qhya]
- [x] [2.2] Create `apps/swift/nexus-mac/Sources/Dashboard/SpecDetailView.swift` — accepts a `SpecSummary?`, fetches markdown via fetchSpecContent on selection change, renders via `Text(try AttributedString(markdown: body, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))`. Tab picker for proposal/design/tasks. Empty state when no spec selected [owner:ui-engineer] [type:feature] [beads:nx-vem8o]
- [x] [2.3] Restructure `apps/swift/nexus-mac/Sources/Dashboard/SpecsView.swift` to embed the existing list in an `HSplitView` (or `NavigationSplitView`) with SpecDetailView on the right. Pass `@State var selectedSpec: SpecSummary?` between panes. Keep the existing project-grouped list rendering intact [owner:ui-engineer] [type:feature] [beads:nx-wsll2]
- [x] [2.4] Restructure `apps/swift/nexus-mac/Sources/Dashboard/NotificationsView.swift`: replace `HSplitView { historyPane, settingsPane }` with `VStack { historyPane, settingsToolbar }`. The settingsToolbar is a horizontal compact row (Mode picker, Signal-only toggle, Suppression stepper, Ducking menu). Body gets full width. Settings remain bound to the same NotificationsModel [owner:ui-engineer] [type:feature] [beads:nx-3im13]
- [x] [2.5] [P-2] Convert `apps/swift/NexusShared/Synthesis/SystemSpeechSynthesizer.swift` from `@MainActor final class` to `actor`. Add private `private var current: Process?` and `private var pending: Task<Void, Never>?`. Each `speak()` call appends a Task that awaits `pending` then `current?.waitUntilExit()` before launching the new Process. Public `speak(_ text: String, rate: Int = 175)` signature unchanged. Subprocess failure is logged via os_log + does NOT stall the queue [owner:ui-engineer] [type:feature] [beads:nx-qna77]
- [x] [2.6] [P-2] If TTSObserver was holding `systemSpeech: SystemSpeechSynthesizer?` as optional defaulted-to-nil, switch to non-optional with `= SystemSpeechSynthesizer()` default — actor types initialize freely [owner:ui-engineer] [type:feature] [beads:nx-6dgfe]

## E2E Batch

- [ ] [3.1] Add `apps/swift/NexusSharedTests/SystemSpeechSynthesizerTests.swift` with 3 tests: testSequentialUtterancesDoNotOverlap (fire 3 speak calls, assert each completes before the next begins via test hook), testSpeakReturnsImmediately (assert < 50ms latency), testSubprocessFailureDoesNotJamQueue (inject failing arg vector, assert next speak still runs) [owner:ui-engineer] [type:test] [beads:nx-i1jxz]
- [ ] [3.2] Add `apps/swift/NexusSharedTests/MarkdownRenderingTests.swift` (or extend PayloadDecodeTests) with 2 tests: testMarkdownDecodesBoldItalic (fixture with `**bold** *italic*` decodes to formatted AttributedString), testMarkdownEmptyDoesNotCrash (empty string → empty AttributedString, no throw) [owner:ui-engineer] [type:test] [beads:nx-d1pas]
- [ ] [3.3] Deploy: push + ssh-pull-on-homelab. Verify agent serves `GET /specs/nx/dashboard-ui-pass-v1/proposal` via Tailscale curl with text/markdown content [owner:devops-engineer] [type:test] [beads:nx-7vuhb]
- [ ] [3.4] [user] Open Nexus.app: (a) Specs tab → click a spec, verify proposal renders in the right pane; switch tabs to design/tasks. (b) Notifications tab → confirm body is full-width and settings toolbar is at the bottom. (c) Fire 3 nx_notify calls rapidly and confirm audio is sequential, not overlapping. Capture 3 screenshots [user] [owner:user] [type:test] [beads:nx-b3er4]
- [ ] [3.5] Update `openspec/specs/swift-menubar-client/spec.md` post-archive [handled by Phase 4 archive] [owner:devops-engineer] [type:docs] [beads:nx-avn02]
