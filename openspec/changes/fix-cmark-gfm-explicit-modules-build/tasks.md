<!-- beads:epic:nx-sk3dc -->
<!-- beads:feature:nx-xhrba -->

# Tasks: fix-cmark-gfm-explicit-modules-build

## API Batch

Fix the Tier B build, validated by running `build-for-testing` to green. Touches `deploy/run-tier-b-xcuitests.sh`.

- [ ] [1.1] Reproduce + confirm the root cause: run the harness's `xcodebuild build-for-testing` invocation (the exact one at ~line 109, into the override DD) and confirm the `_DarwinFoundation*.pcm module file not found` failure. Inspect whether the missing `.pcm` path sits under the override `-derivedDataPath` (`/tmp/nx-tier-b-uibuild`) vs the default DerivedData — this confirms the SPM-relocation hypothesis. Capture the evidence. [owner:devops-engineer] [type:ci-cd] [beads:nx-asrnt]
- [ ] [1.2] Apply candidate #1 (SPM artifact relocation): add `-clonedSourcePackagesDirPath <stable path OUTSIDE the override DD>` to BOTH the `build-for-testing` and `test-without-building` invocations (and/or stop overriding `-derivedDataPath` if that is cleaner), keeping the two steps consistent. Run `build-for-testing` and check whether the `.pcm` error clears. If it goes green, this is the fix. [owner:devops-engineer] [type:ci-cd] [beads:nx-qtuy1]
- [ ] [1.3] If #1 does not clear it, apply candidate #2 (disable explicitly-built modules for the gate build): determine the correct Xcode-16 build-setting override (verify via `xcodebuild -showBuildSettings | grep -i explicit` + current docs — do NOT guess the key) and pass it to both xcodebuild steps so the C target falls back to implicit modules. Run `build-for-testing` to confirm green. Keep the change scoped to the harness flags. [owner:devops-engineer] [type:ci-cd] [beads:nx-s82un]
- [ ] [1.4] Confirm the chosen fix keeps `build-for-testing` and `test-without-building` consistent (same DD/SPM strategy) and preserves the existing `SKIP_TIER_B_RUN` skip + perms-timeout SKIP paths unchanged. Paste the green `build-for-testing` output (RC 0, no `.pcm` error) as evidence. If NEITHER candidate works without touching `apps/swift/nexus/project.yml`, STOP and escalate before modifying project config. [owner:devops-engineer] [type:ci-cd] [beads:nx-ln5dp]

## E2E Batch

Prove the gate is green end-to-end and retire the skip. Do NOT set `SKIP_TIER_B_RUN`.

- [ ] [2.1] Run the full fixed harness end-to-end WITHOUT `SKIP_TIER_B_RUN` from a GUI-capable macOS session; confirm it passes `build-for-testing` (no `.pcm` error) and proceeds to `test-without-building` (real result OR the graceful perms-timeout SKIP — both acceptable). Capture the full output + RC. [owner:e2e-engineer] [type:testing] [beads:nx-6pryh]
- [ ] [2.2] Confirm the pre-push Tier B gate no longer aborts at the build stage without `SKIP_TIER_B_RUN` (run the hook's tier-b path, or a controlled push, to verify). Then close `nx-j5bww` with the evidence, and update the `tier-b-gate-blocked-by-cmark-gfm-build` bd memory to reflect the gate is now green (or note any residual perms-only requirement). [owner:e2e-engineer] [type:infra] [beads:nx-xnrw7]
