---
order: 0724i
---

# Proposal: Wire the macOS Swift CI Job

## Change ID
`wire-macos-swift-ci`

> Advisor stamp: 2026-07-24 `/improve` run against commit `9e4963b9`. Verify cited lines before starting; STOP on drift.

## Summary
`ci.yml` carries a fully-sketched but commented-out macOS job ("STRETCH — not wired", `ci.yml:66+` at base): xcodegen generate + `xcodebuild test` over `nexus-mac-Tests` and `NexusSharedTests`. Meanwhile the 2026-07-24 audit's four vetted defects in recent churn were ALL Swift-side — the suite where the waves land has zero CI. Uncomment and finish the job on a chosen runner.

## Context
- depends on: `update-ci-gates-header`
- touches: `.github/workflows/ci.yml`

## Motivation
Evidence from this audit run: `fix-swift-tts-audit-defects` (four defects, none catchable by the Linux gates) and Swift-dominant churn in waves 1–3 (swift-tts-provider-chain, provider-qualified-project-voices UI, meeting-detection-running-app-gate — the last landed Swift-only). The Linux job cannot compile Swift; the existing commented scaffold already encodes the right shape (`CODE_SIGNING_ALLOWED=NO`, `-only-testing` scoping). Depends on `update-ci-gates-header` (same file — land the header rewrite first) — iOS/watch bundle coverage stays a separate gap per the scaffold's own note (plans/014).

## Testing
- A PR touching `apps/swift/**` triggers the job; a deliberately broken Swift test on a branch turns it red; reverting turns it green.
- Runtime and cost observed over the first week (metered minutes budget or self-hosted queue depth) recorded in the PR.

## Done Means
- Swift changes cannot merge green without compiling and passing `nexus-mac-Tests` + `NexusSharedTests`.
- The job is scoped (path filter on `apps/swift/**` plus workflow changes) so TS-only pushes don't consume Mac minutes.
- The commented-out scaffold is gone — replaced by the live job.

## Scope
- **IN**: uncommenting/finishing the `macos-swift` job (runner selection per the decision task; path filter; cache for xcodegen/SwiftPM if trivial).
- **OUT**: iOS/watchOS test bundles (tracked separately, plans/014 per the scaffold note); code signing; release/archive builds; the Linux job.
