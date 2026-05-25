# fix-tier-b-xcuitest-harness

## Why

The Tier B XCUITest runner (`deploy/run-tier-b-xcuitests.sh`) blocks `git push` via the
pre-push integration gate. On 2026-05-25 a push aborted with:

```
(12 failures)
deploy/run-tier-b-xcuitests.sh: line 61: TEST_LOGS[@]: unbound variable
```

The `TEST_LOGS[@]: unbound variable` line is a **harness bug, and it masks the real failure**:

1. The script runs under `set -euo pipefail` with `#!/usr/bin/env bash`, which on this host
   resolves to **bash 3.2.57** (system bash — homebrew bash is not ahead in the hook's PATH).
2. bash 3.2 has the well-known empty-array-under-`nounset` defect: expanding `"${TEST_LOGS[@]}"`
   when the array is empty raises `unbound variable`. Confirmed by direct repro.
3. `cleanup()` (trap on EXIT) expands `"${TEST_LOGS[@]}"` at line 64. `TEST_LOGS` is only
   populated at line 132 — AFTER `xcodebuild build-for-testing` (line 109). So when an earlier
   `set -e` abort fires (a build failure, a stub failure, or any exit before line 132), the
   cleanup trap crashes on the empty array and the `unbound variable` message **overwrites the
   real failure output and exit code**.

Net effect: an operator cannot tell whether Tier B failed because of a Swift compile error, a
genuine test regression, or a missing-Accessibility-perms timeout (which the harness already
has a graceful SKIP path for). The masking forces blind `SKIP_TIER_B_RUN=1` retries — which is
exactly the whole-gate-bypass behavior the gate was hardened against.

## What Changes

### API Batch — make the harness fail loudly and correctly

- Fix the bash 3.2 empty-array crash: expand `TEST_LOGS` with the nounset-safe guard
  (`"${TEST_LOGS[@]+"${TEST_LOGS[@]}"}"`) and audit the script for any other unguarded array
  expansion under `set -u`.
- Ensure `cleanup()` never overwrites the real exit: cleanup must not be the thing that
  determines the script's exit code, and must not emit errors that bury the genuine failure.
- Add explicit failure-stage attribution: when an `xcodebuild` step fails, the harness reports
  WHICH stage (`build-for-testing` vs `test-without-building`) and preserves its output, so a
  build break is distinguishable from a test regression from the existing perms-timeout SKIP.

### E2E Batch — surface and file the real Tier B failures (do NOT blind-fix)

- Run the fixed harness once (no `SKIP_TIER_B_RUN`) to surface the actual failures now that
  they are no longer masked; capture the failing stage and full output.
- Categorize each surfaced failure (Swift build error / real test regression / env-perms) and
  FILE it as a triaged beads issue under the `test-infrastructure` capability, linked to this
  feature. Fixing those underlying failures is explicitly out of scope here.
- Confirm the harness now exits with the real code and a clear banner (not the
  `unbound variable` line).

## Context

- depends on: (none)
- touches: `deploy/run-tier-b-xcuitests.sh`

## Non-Goals

- Fixing the underlying 12 Tier B failures — they cannot be scoped until the harness fix makes
  them visible; they are filed as separate triaged beads issues.
- Changing the integration gate's blocking contract or the `SKIP_TIER_B_RUN` escape hatch.
- Rewriting the harness in another language or requiring homebrew bash for git hooks (the fix
  must be bash-3.2-safe).
