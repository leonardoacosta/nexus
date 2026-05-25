# fix-cmark-gfm-explicit-modules-build

## Why

The Tier B XCUITest pre-push gate (`deploy/run-tier-b-xcuitests.sh`) fails at
`build-for-testing` (RC 65) — surfaced by the now-fixed harness and filed as `nx-j5bww`. The
`cmark-gfm` SwiftPM C target (transitive via swift-markdown) cannot find explicitly-precompiled
`_DarwinFoundation*.pcm` modules:

```
MacOSX26.4.sdk/usr/include/assert.h: fatal error: module file
  '.../ExplicitPrecompiledModules/_DarwinFoundation1-...pcm' not found: module file not found
```

Until this is fixed, every push needs `SKIP_TIER_B_RUN=1`, which defeats the gate. Research
(Apple Developer Forums, Swift Forums, Bitrise/Use Your Loaf on Xcode 16 explicitly-built
modules) points to two documented root causes that combine here:

1. **The custom `-derivedDataPath` override breaks SwiftPM artifact resolution.** Apple guidance:
   the SwiftPM cache must live outside the project, and `-derivedDataPath` relocates it so the
   explicit-module `.pcm` lookup points where the artifact was never emitted. The harness passes
   `-derivedDataPath /tmp/nx-tier-b-uibuild` to BOTH `build-for-testing` and
   `test-without-building`.
2. **Explicitly-built modules are default-ON for C/ObjC targets in Xcode 16+** (experimental for
   Swift). The `cmark-gfm` C target goes through the explicit-module path and hits the missing
   `.pcm`. Falling back to implicit module builds avoids it.

The exact winning fix cannot be asserted without running it — so this spec carries a researched
candidate ladder and makes the build go GREEN with runtime evidence rather than guessing.

## What Changes

### API Batch — fix the Tier B build, validated empirically

Determine and apply the minimal fix to the harness's `xcodebuild` invocations so
`build-for-testing` compiles `cmark-gfm` successfully. Work the researched candidate ladder in
order, validating each by actually running `build-for-testing`:

1. **Relocate the SwiftPM clone dir outside the override DD** — add
   `-clonedSourcePackagesDirPath <stable path outside the DD>` (and/or stop overriding
   `-derivedDataPath`) so SPM artifact resolution stops pointing into a relocated cache.
2. **Disable explicitly-built modules for the gate build** — pass the correct Xcode-16
   build-setting override to fall back to implicit modules for the C target.

Keep the fix scoped to the harness's `xcodebuild` flags. Both `build-for-testing` and
`test-without-building` MUST use a consistent DD/SPM strategy (they have to agree or the test
step can't find the built product). Touch `apps/swift/nexus/project.yml` ONLY as a documented
fallback if no harness-flag approach works — escalate before doing so.

### E2E Batch — prove green and retire the skip

Run the full fixed harness WITHOUT `SKIP_TIER_B_RUN`, confirm `build-for-testing` passes (no
`.pcm` error) and the suite proceeds to the test stage. Confirm the pre-push gate no longer
needs `SKIP_TIER_B_RUN`, close `nx-j5bww`, and update the `tier-b-gate-blocked-by-cmark-gfm-build`
bd memory.

## Context

- depends on: (none)
- touches: `deploy/run-tier-b-xcuitests.sh`, `apps/swift/nexus/project.yml`

## Non-Goals

- Changing the Tier B gate's blocking contract or removing the `SKIP_TIER_B_RUN` escape hatch
  (it stays as a sanctioned narrow skip).
- Upgrading/downgrading swift-markdown or cmark-gfm versions (the fix is a build-config change,
  not a dependency bump) unless empirically proven necessary — escalate first.
- Re-enabling explicitly-built modules project-wide for the normal dev build (out of scope; the
  fix targets the gate build).
