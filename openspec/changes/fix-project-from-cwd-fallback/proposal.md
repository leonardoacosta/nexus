# Proposal: Fix project_from_cwd Fallback Matching System Paths

## Change ID
`fix-project-from-cwd-fallback`

## Summary
Remove the unsafe "last component if short enough" fallback in `project_from_cwd` that incorrectly matches system paths like `/tmp` -> "tmp" and `/var/log` -> "log". The `dev/` prefix strategy is the correct primary heuristic.

## Context
- Extends: `crates/nexus-core/src/lifecycle.rs:234-239`
- Related: Test at line 258 expects `""` for `/home/user` but the fallback would return `"user"` for 4-char usernames

## Motivation
The fallback heuristic at lines 234-239 matches any path whose last component is 6 chars or fewer and all-lowercase. This produces false positives for system directories (`/tmp` -> "tmp", `/var/log` -> "log", `/usr/bin` -> "bin") and home directories (`/home/dev` -> "dev"). The existing test at line 257-258 demonstrates the inconsistency: it expects `project_from_cwd("/tmp")` to return `"tmp"` which is wrong (tmp is not a project). The `"dev"` parent component match at line 227 is the reliable strategy and should be the sole heuristic.

## Requirements
### Req-1: Remove fallback heuristic
Remove the "last component if short enough" fallback that matches arbitrary short directory names as project codes.

### Req-2: Return empty string for non-dev paths
When a path does not contain a `dev/` component, `project_from_cwd` SHALL return an empty string.

## Scope
- **IN**: Removing the fallback heuristic, fixing tests to match correct behavior
- **OUT**: Adding additional heuristics, making `dev/` configurable

## Impact
| Area | Change |
|------|--------|
| lifecycle.rs | Remove 5 lines of fallback logic |
| lifecycle.rs tests | Fix assertions for `/tmp` and other non-dev paths |

## Risks
| Risk | Mitigation |
|------|-----------|
| Sessions outside ~/dev/ lose project detection | These were false positives anyway; empty string is more correct than "tmp" or "log" |
