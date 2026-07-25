---
stack: t3
---
<!-- beads:epic:nx-yn00u -->
<!-- beads:feature:nx-oobfm -->

# Tasks — wire-macos-swift-ci

## API Batch

- [x] 1.1 [user] DECISION: choose the runner — RESOLVED (superseded 2026-07-25): self-host Leo's own Mac as a GitHub Actions self-hosted runner. Blacksmith (the original choice) confirmed structurally non-viable — requires an org-owned repo, nexus is personal-account. Depot.dev evaluated and rejected for the identical restriction. See decisions.jsonl for both rows. [type:config] [beads:nx-82ari]
- [ ] 1.2 (REOPENED 2026-07-25 — original Blacksmith wiring invalidated) Register Leo's Mac as a self-hosted GitHub Actions runner for this repo (download+configure the actions-runner package, install as a launchd service so it survives reboots/logout). Update the `macos-swift` job in `ci.yml` to `runs-on: [self-hosted, macOS]` (or an equivalent label set matching the registered runner), keeping: `brew install xcodegen` (or preinstalled check), `cd apps/swift && xcodegen generate`, `xcodebuild test -project apps/swift/nexus.xcodeproj -scheme nexus-mac -destination 'platform=macOS' -only-testing:nexus-mac-Tests -only-testing:NexusSharedTests CODE_SIGNING_ALLOWED=NO`, the `apps/swift/**`+workflow-file path filter, and the deleted scaffold comment block (all already correct from the prior implementation — only `runs-on:` and the Blacksmith-specific comment need to change). [type:config] [beads:nx-sl0lv]
  - touches: `.github/workflows/ci.yml`

## E2E Batch

- [ ] 2.1 Verify: open a PR with a deliberate one-line Swift test failure — job red; revert — job green. Paste both run links and the observed job duration/minutes cost. [type:testing] [beads:nx-v4fj6]
