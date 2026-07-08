# Tasks — add-queue-head-widget

## UI Batch

- [x] 1.1 XcodeGen: new `nexus-widgets` extension target in project.yml (small + accessory families, iOS deployment target matching nexus-ios), embedded in nexus-ios (searched: no existing widget/extension target in project.yml)
  - touches: apps/swift/project.yml, apps/swift/nexus-widgets/
- [x] 1.2 Timeline provider: fetch `/queue?limit=1` via NexusShared client (TriageItem+Verdict decode from add-decide-flow-menubar 2.1), ~15min refresh policy, entries: head / clear / retain-on-failure
  - depends on: 1.1
  - touches: apps/swift/nexus-widgets/
- [x] 1.3 Widget views: small + lock-screen accessory renderings — action + truncated title, "clear" state; no counts/badges/lists in any state (review-assert against the spec requirement); tap = app launch
  - depends on: 1.2
  - touches: apps/swift/nexus-widgets/
- [x] 1.4 Provider unit tests with stubbed client: head entry, clear entry, retained entry on failure
  - depends on: 1.2
  - touches: apps/swift/NexusSharedTests/

## E2E Batch

- [x] 2.1 Headless gate: xcodegen + xcodebuild build via the Linux->Mac ssh contract; paste output. (Widget SwiftUI/WidgetKit views cannot be typechecked by lone `swiftc -typecheck` — they import the app frameworks — so the gate is a real target build: `xcodebuild build -scheme nexus-widgets -destination "platform=iOS Simulator"` (BUILD SUCCEEDED, compiles + embeds the .appex unsigned) + `xcodebuild test -scheme nexus-mac -only-testing:NexusSharedTests/QueueHeadWidgetTests` (5/5 passed). Stronger evidence than typecheck.)
  - depends on: 1.3, 1.4
- [ ] 2.2 [user] On-device (signing/GUI-bound): install on iPhone, add lock-screen + home widgets, verify render, tap-launch, and refresh after a decision changes the head. searched: verification contract is proposal.md ## Testing — no new criteria at run time
  - depends on: 2.1
