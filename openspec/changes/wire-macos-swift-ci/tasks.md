---
stack: t3
---
<!-- beads:epic:nx-yn00u -->
<!-- beads:feature:nx-oobfm -->

# Tasks — wire-macos-swift-ci

## API Batch

- [x] 1.1 [user] DECISION: choose the runner — RESOLVED: Blacksmith (`blacksmith-6vcpu-macos-latest` runs-on tag). Requires the Blacksmith GitHub App installed at app.blacksmith.sh — a manual prerequisite the operator must complete before this job can actually run. See decisions.jsonl. [type:config] [beads:nx-82ari]
- [x] 1.2 Uncomment and finish the `macos-swift` job from the `ci.yml:66+` scaffold on the chosen runner: `brew install xcodegen` (or preinstalled check), `cd apps/swift && xcodegen generate`, `xcodebuild test -project apps/swift/nexus.xcodeproj -scheme nexus-mac -destination 'platform=macOS' -only-testing:nexus-mac-Tests -only-testing:NexusSharedTests CODE_SIGNING_ALLOWED=NO`. Add a path filter so the job runs only on `apps/swift/**` and workflow-file changes. Delete the scaffold comment block. [type:config] [beads:nx-sl0lv]
  - touches: `.github/workflows/ci.yml`

## E2E Batch

- [ ] 2.1 Verify: open a PR with a deliberate one-line Swift test failure — job red; revert — job green. Paste both run links and the observed job duration/minutes cost. [type:testing] [beads:nx-v4fj6]
