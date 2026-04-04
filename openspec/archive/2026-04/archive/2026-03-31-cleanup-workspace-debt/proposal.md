# Proposal: Clean up workspace debt

## Change ID
`cleanup-workspace-debt`

## Summary
Remove 29 orphaned `tmp.*.rs` files (11K LOC dead code), fix the broken `query_http_aggregation`
test, add a gitignore rule to prevent tmp file accumulation, and normalize proto naming.

## Context
- Extends: `.gitignore`, `crates/nexus-agent/src/failures.rs`
- Related: Audit finding from 2026-03-30 session — all severity levels

## Motivation
29 `tmp.*.rs` files from failed agent attempts pollute grep results, confuse tooling, and inflate
the repo by 11K lines. One pre-existing test failure masks real regressions. These are zero-risk
fixes that immediately improve DX.

## Requirements

### Req-1: Remove all tmp.*.rs files
Delete all files matching `tmp.*.rs` across all crates. These are orphaned agent artifacts — not
referenced by any `mod.rs` and never compiled.

### Req-2: Prevent recurrence
Add `tmp.*.rs` to `.gitignore` so future agent artifacts aren't committed.

### Req-3: Fix broken test
The `failures::tests::query_http_aggregation` test has a stale assertion (`"command failed"` vs
actual output). Fix or update the assertion.

## Scope
- **IN**: tmp file cleanup, gitignore rule, broken test fix
- **OUT**: proto naming normalization (deferred — breaking change for Nova)

## Impact
| Area | Change |
|------|--------|
| All crates | Delete 29 tmp.*.rs files |
| .gitignore | Add tmp.*.rs exclusion |
| nexus-agent/src/failures.rs | Fix test assertion |

## Risks
| Risk | Mitigation |
|------|-----------|
| Deleting a file that's actually used | Verified: none are in mod.rs, none compile |
