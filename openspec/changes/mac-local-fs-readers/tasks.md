# Tasks: mac-local-fs-readers

<!-- beads:epic:nx-rxlbi -->
<!-- beads:feature:nx-6x2sx -->

## API Batch

- [ ] [1.1] Create `apps/swift/NexusShared/LocalSources/WorkspaceRoots.swift` — `public struct WorkspaceRoots` with default `[~/dev]` and a load/save API persisting to UserDefaults. Expose `resolved() -> [URL]` that returns glob-expanded directories actually present on disk [owner:ui-engineer] [type:feature] [beads:nx-5bhie]
- [ ] [1.2] [P-1] Create `apps/swift/NexusShared/LocalSources/SpecsLocalReader.swift` — `public final class SpecsLocalReader` with `read(roots: [URL]) async -> [SpecSummary]`. For each root, glob `<root>/<project>/openspec/changes/<spec>/`, build SpecSummary with: name=<spec>, project=<project>, status="open" if path exists in changes/ else "archived", completedTasks/totalTasks from grep of `^- \[x\]` and `^- \[ \]` in tasks.md, hasProposal/hasDesign/hasTasks from existsSync per file [owner:ui-engineer] [type:feature] [beads:nx-gpzm2]
- [ ] [1.3] [P-1] Create `apps/swift/NexusShared/LocalSources/CredentialsLocalReader.swift` — `public final class CredentialsLocalReader` with `read() async -> CredentialsResponse`. Read `~/.claude/.credentials/` (verify the canonical path — may be `~/.claude/.credentials.json` or a dir; inspect filesystem first). Project each entry into the wire shape that CredentialsView currently expects. activeFingerprint comes from whichever credential matches the running CC session's selection [owner:ui-engineer] [type:feature] [beads:nx-fuwb5]
- [ ] [1.4] Extend `apps/swift/NexusShared/Networking/NexusAggregateClient.swift` `fetchSpecs()` to invoke SpecsLocalReader in parallel with the existing per-agent fetchSpecs loop, merge by (project, name) key with local-wins precedence [owner:ui-engineer] [type:feature] [beads:nx-8sz9r]
- [ ] [1.5] [P-2] Extend `NexusAggregateClient.fetchCredentials()` similarly with CredentialsLocalReader merge [owner:ui-engineer] [type:feature] [beads:nx-kj1ks]
- [ ] [1.6] [P-2] Add os_log instrumentation to both readers: roots scanned, entries produced, errors encountered (with `%{public}@` formatters) [owner:ui-engineer] [type:feature] [beads:nx-a7jl8]

## UI Batch

- [ ] [2.1] Verify `apps/swift/nexus-mac/Sources/Dashboard/SpecsView.swift` calls `client.fetchSpecs()` on mount — if it already does (per earlier grep showing line 156: `specs = await client.fetchSpecs()`), no change needed; the aggregate method now returns merged local+remote data transparently [owner:ui-engineer] [type:feature] [beads:nx-jykyt]
- [ ] [2.2] [P-1] Same verification for `CredentialsView.swift` — `fetchCredentials()` already wired; aggregate handles the merge transparently [owner:ui-engineer] [type:feature] [beads:nx-kswyk]
- [ ] [2.3] [P-1] Add a Settings tab section in `apps/swift/nexus-mac/Sources/Dashboard/SettingsView.swift` (or equivalent) for "Workspace Roots" — list of paths the user can add/remove. Persists to UserDefaults via WorkspaceRoots.save() [owner:ui-engineer] [type:feature] [beads:nx-3d042]
- [ ] [2.4] Add a "Refresh" button to SpecsView + CredentialsView headers so the user can manually re-fetch without view re-mount (since we're not adding FSEvents in this spec) [owner:ui-engineer] [type:feature] [beads:nx-iceal]

## E2E Batch

- [ ] [3.1] Add `apps/swift/NexusSharedTests/SpecsLocalReaderTests.swift` with 4 unit tests: testReadEmptyRoot (no ~/dev), testReadProjectWithFullSpec (proposal+design+tasks present), testReadProjectWithPartialSpec (only proposal.md → tri-state false/false for design+tasks), testReadCompletedTaskCount (grep `[x]` accuracy) [owner:ui-engineer] [type:test] [beads:nx-c48ip]
- [ ] [3.2] [P-1] Add `apps/swift/NexusSharedTests/CredentialsLocalReaderTests.swift` with 3 unit tests: testReadMissingDir, testReadSingleCredential, testReadActiveFingerprintDetection [owner:ui-engineer] [type:test] [beads:nx-55pp0]
- [ ] [3.3] Add aggregate-merge tests in `apps/swift/NexusSharedTests/NexusAggregateClientTests.swift` (or new file) verifying local-wins precedence on key collision and parallel fetch timing [owner:ui-engineer] [type:test] [beads:nx-q2a71]
- [ ] [3.4] Runtime smoke [user]: open Nexus.app dashboard, navigate to Specs tab, confirm at least one local spec from `~/dev/nx/openspec/changes/` appears. Same for Credentials tab — should show at least one entry from `~/.claude/.credentials/` (if any exists). Capture screenshot for the audit trail [user] [owner:user] [type:test] [beads:nx-56z0h]
- [ ] [3.5] Update `openspec/specs/swift-menubar-client/spec.md` post-archive with the new local-source guarantees [handled by Phase 4 archive] [owner:devops-engineer] [type:docs] [beads:nx-qzlz3]
