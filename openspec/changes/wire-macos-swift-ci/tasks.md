---
stack: t3
---
<!-- beads:epic:nx-yn00u -->
<!-- beads:feature:nx-oobfm -->

# Tasks — wire-macos-swift-ci

## API Batch

- [x] 1.1 [user] DECISION: choose the runner — RESOLVED (superseded 2026-07-25): self-host Leo's own Mac as a GitHub Actions self-hosted runner. Blacksmith (the original choice) confirmed structurally non-viable — requires an org-owned repo, nexus is personal-account. Depot.dev evaluated and rejected for the identical restriction. See decisions.jsonl for both rows. [type:config] [beads:nx-82ari]
- [x] 1.2 (REOPENED 2026-07-25, redone against self-hosted Mac) Registered Leo's Mac as a self-hosted GitHub Actions runner (`nexus-mac-runner`, launchd service via `~/actions-runner/svc.sh`). `ci.yml`'s `macos-swift` job now runs on `[self-hosted, macOS, nexus-mac]`. Also fixed a real gap found during verification: `xcodegen generate` failed on a clean CI checkout because the gitignored `Secrets.xcconfig` doesn't exist there — added a step seeding the committed placeholder-only `Secrets.example.xcconfig` when the real file is absent (commit `cdeda852`). Verified end-to-end: gh run 30144859518, Swift gates job success, 191/191 tests, 44s wall clock. [type:config] [beads:nx-sl0lv]
  - touches: `.github/workflows/ci.yml`

## E2E Batch

- [ ] 2.1 Verify: open a PR with a deliberate one-line Swift test failure — job red; revert — job green. Paste both run links and the observed job duration/minutes cost. [type:testing] [beads:nx-v4fj6]
