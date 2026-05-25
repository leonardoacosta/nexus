<!-- beads:epic:nx-sk3dc -->
<!-- beads:feature:nx-z19vx -->

# Tasks: fix-tier-b-xcuitest-harness

## API Batch

Make the harness fail loudly and correctly (bash-3.2-safe). Touches `deploy/run-tier-b-xcuitests.sh`.

- [x] [1.1] Fix the bash 3.2 empty-array crash in `deploy/run-tier-b-xcuitests.sh`: replace the line ~64 `for log in "${TEST_LOGS[@]}"` expansion with the nounset-safe form `"${TEST_LOGS[@]+"${TEST_LOGS[@]}"}"`, and audit the whole script for any other array expansion unguarded under `set -u`. Verify the fix with a bash 3.2 (`/bin/bash`) repro running `cleanup` with an empty `TEST_LOGS`. [owner:devops-engineer] [type:ci-cd] [beads:nx-sl8vz]
- [x] [1.2] Ensure `cleanup()` never masks the real failure: cleanup MUST NOT determine the script's exit code and MUST NOT emit errors that bury the genuine failure. When an `xcodebuild` step fails, print a clear stderr banner naming the failing stage (`build-for-testing` vs `test-without-building`) and preserve that stage's output, so a build break, a test regression, and the existing perms-timeout SKIP are all distinguishable. Keep the perms-timeout SKIP path (exit 0) behavior unchanged. [owner:devops-engineer] [type:ci-cd] [beads:nx-dr5f1]
- [x] [1.3] Add a regression guard: a small self-test (e.g. `deploy/tests/tier-b-cleanup.test.sh` run under `/bin/bash` / bash 3.2) that invokes the harness's `cleanup` with an empty `TEST_LOGS` under `set -euo pipefail` and asserts NO `unbound variable` error. Wire it so it can run in CI / locally. [owner:devops-engineer] [type:testing] [beads:nx-cqd7k]

## E2E Batch

Surface and file the real Tier B failures. Do NOT blind-fix them.

- [ ] [2.1] Run the fixed harness once WITHOUT `SKIP_TIER_B_RUN` from a GUI-capable macOS session to surface the now-unmasked failures; capture the failing stage and the full output. Paste the captured output (the real failure, not the `unbound variable` line). [owner:e2e-engineer] [type:testing] [beads:nx-40tqa]
- [ ] [2.2] Categorize each surfaced failure (Swift build error / real test regression / env-perms) and FILE each as a beads issue under the `test-infrastructure` capability (epic), linked to this feature via `bd dep add`. Do NOT fix the underlying failures here. Record the filed issue ids in the task notes. [owner:e2e-engineer] [type:infra] [beads:nx-6nhwl]
- [ ] [2.3] Confirm the harness now exits with the REAL exit code and a clear failing-stage banner (verify the `unbound variable` line is gone). Paste the corrected harness output as evidence. [owner:e2e-engineer] [type:testing] [beads:nx-p1oul]
