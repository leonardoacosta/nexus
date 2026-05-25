<!-- beads:epic:nx-sk3dc -->
<!-- beads:feature:nx-xhrba -->

# Tasks: fix-cmark-gfm-explicit-modules-build

## API Batch

Fix the Tier B build, validated by running `build-for-testing` to green. Touches `deploy/run-tier-b-xcuitests.sh`.

- [x] [1.1] Reproduce + confirm the root cause: ran the harness's `xcodebuild build-for-testing` into the override DD and reproduced `_DarwinFoundation*.pcm`/`_Builtin_*.pcm` module-file-not-found in the cmark-gfm C target. Missing `.pcm` path sits UNDER the override `-derivedDataPath` (`/tmp/nx-tier-b-uibuild/Build/Intermediates.noindex/ExplicitPrecompiledModules/`), and the swift-cmark checkout lives inside the override DD at `SourcePackages/checkouts/` — confirming the SPM-relocation hypothesis (candidate #1). [owner:devops-engineer] [type:ci-cd] [beads:nx-asrnt]
- [x] [1.2] Candidate #1 (SPM artifact relocation) — WON. Added `-clonedSourcePackagesDirPath "$SPM"` (`/tmp/nx-tier-b-spm`, outside the override DD) to BOTH the `build-for-testing` and `test-without-building` invocations. Fresh `build-for-testing` cleared the `.pcm` error: `** TEST BUILD SUCCEEDED **`, RC 0, 0 `.pcm` errors. [owner:devops-engineer] [type:ci-cd] [beads:nx-qtuy1]
- [x] [1.3] Candidate #2 NOT needed — candidate #1 (SPM relocation) fixed the build, so disabling explicitly-built modules was unnecessary. No build-setting override applied. [owner:devops-engineer] [type:ci-cd] [beads:nx-s82un]
- [x] [1.4] Confirmed consistency: both `build-for-testing` and `test-without-building` share `-derivedDataPath "$DD"` + `-clonedSourcePackagesDirPath "$SPM"` (same DD/SPM strategy → test step finds the built product). `SKIP_TIER_B_RUN` escape hatch, perms-timeout SKIP, `main()` source-guard, and failing-stage banners all unchanged (verified via `deploy/tests/tier-b-cleanup.test.sh` PASS + bash-3.2 `-n` syntax check). Final harness-flag `build-for-testing` run: RC 0, `** TEST BUILD SUCCEEDED **`, 0 `.pcm` errors, 0 fatal errors. No `project.yml` change required. [owner:devops-engineer] [type:ci-cd] [beads:nx-ln5dp]

## E2E Batch

Prove the gate is green end-to-end and retire the skip. Do NOT set `SKIP_TIER_B_RUN`.

- [ ] [2.1] Run the full fixed harness end-to-end WITHOUT `SKIP_TIER_B_RUN` from a GUI-capable macOS session; confirm it passes `build-for-testing` (no `.pcm` error) and proceeds to `test-without-building` (real result OR the graceful perms-timeout SKIP — both acceptable). Capture the full output + RC. [owner:e2e-engineer] [type:testing] [beads:nx-6pryh]
- [ ] [2.2] Confirm the pre-push Tier B gate no longer aborts at the build stage without `SKIP_TIER_B_RUN` (run the hook's tier-b path, or a controlled push, to verify). Then close `nx-j5bww` with the evidence, and update the `tier-b-gate-blocked-by-cmark-gfm-build` bd memory to reflect the gate is now green (or note any residual perms-only requirement). [owner:e2e-engineer] [type:infra] [beads:nx-xnrw7]
