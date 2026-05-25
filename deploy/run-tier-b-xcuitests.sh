#!/usr/bin/env bash
#
# Tier B XCUITest runner for the full-stack integration gate
# (spec add-fullstack-integration-test-gate 2.2-2.4, bd:nx-68ulr).
#
# Invoked by deploy/hooks.d/pre-push/01-deploy ONLY on a macOS host with a
# usable GUI session (the hook's GUI guard decides). A non-zero exit aborts
# the push (the hook wraps this in its fail() contract).
#
# Why this wrapper exists
# -----------------------
# The XCUITest runner (nexus-mac-UITests-Runner.app) is sandboxed with only
# `network.client` (no `network.server`). A stub-agent spawned BY the test
# inherits that sandbox and cannot bind a listening socket (EADDRINUSE on
# every bind — loopback or not). The spec REQUIRES a non-loopback bind
# (loopback is ATS-exempt on macOS → would false-green the -1022 guard), so
# moving the stub to loopback is not an option.
#
# Resolution: start the stub HERE (outside any sandbox), bound non-loopback,
# and export NX_STUB_BASE_URL. `xcodebuild test` propagates this env to the
# test bundle; IntegrationGateUITests reads ProcessInfo.environment and uses
# it instead of self-spawning. The app under test still performs the real
# cleartext HTTP round-trip, so the ATS -1022 fault is faithfully guarded.
#
# Also: nexus-mac carries App Sandbox + APNs + iCloud entitlements that need
# a provisioned dev cert the unsigned dev env lacks; the unsigned XCUITest
# runner is then killed before it can attach. We override
# CODE_SIGN_ENTITLEMENTS to the stripped nexus-uitest.entitlements (only
# network.client) and ad-hoc sign so the runner attaches.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SWIFT_DIR="$REPO_DIR/apps/swift"
STUB_TS="$REPO_DIR/apps/agent/src/testing/stub-agent.ts"
TEST_ENTITLEMENTS="$SWIFT_DIR/nexus/nexus/nexus-uitest.entitlements"
DD="${NX_TIER_B_DERIVED_DATA:-/tmp/nx-tier-b-uibuild}"

STUB_LOG=""
STUB_PID=""
# Additional temp logs (e.g. the xcodebuild test log used for the
# perms-timeout SKIP detection in step 3) push their paths onto this
# array so cleanup() can remove them on exit.
TEST_LOGS=()

cleanup() {
  # Every command here is `|| true`-guarded: a cleanup hiccup must NEVER flip
  # the script's exit code or bury the genuine failure (bd:nx-dr5f1). The
  # array expansion uses the bash-3.2 nounset-safe `${arr[@]+...}` alternate
  # form: under `set -u`, expanding an empty array as `"${TEST_LOGS[@]}"`
  # raises `unbound variable` on bash 3.2 (bd:nx-sl8vz).
  { [[ -n "${STUB_PID:-}" ]] && kill "$STUB_PID" 2>/dev/null; } || true
  rm -f "$STUB_LOG" 2>/dev/null || true
  for log in "${TEST_LOGS[@]+"${TEST_LOGS[@]}"}"; do
    rm -f "$log" 2>/dev/null || true
  done
}

# main() holds the full executing body of the gate. It is invoked only when
# this file is run directly (see the run-if-main guard at the bottom). When the
# file is *sourced* (e.g. by deploy/tests/tier-b-cleanup.test.sh, bd:nx-cqd7k)
# only the function + variable definitions above load, so the test can call
# cleanup() with an empty TEST_LOGS without launching the stub or xcodebuild.
main() {
  # Escape hatch (matches the pre-push hook's SKIP_* convention, e.g.
  # SKIP_DEPLOY / SKIP_BUNDLE_INTEGRITY). When set, the runner logs an explicit,
  # NON-failing skip and exits 0. Used by deploy/selftest-pre-push-gate.sh case
  # (c) to validate the GUI-present clean path of the gate orchestration without
  # spending minutes on the full XCUITest suite (which is runtime-verified by
  # tasks 2.2-2.4). A skip is not a failure, so the dispatcher stays exit 0.
  if [[ "${SKIP_TIER_B_RUN:-0}" == "1" ]]; then
      echo "Tier B: SKIP_TIER_B_RUN set — skipping XCUITest run (non-failing)"
      exit 0
  fi

  BUN="$(command -v bun || echo /opt/homebrew/bin/bun)"
  [[ -x "$BUN" ]] || { echo "Tier B: bun not found" >&2; exit 1; }

  STUB_LOG="$(mktemp -t nx-tier-b-stub.XXXXXX)"

  trap cleanup EXIT

# --- 1. start the stub outside the sandbox (non-loopback bind) -----------
"$BUN" "$STUB_TS" >"$STUB_LOG" 2>&1 &
STUB_PID=$!

NX_STUB_BASE_URL=""
for _ in $(seq 1 50); do            # up to ~10s
  line="$(grep -m1 '^STUB_BASE_URL=' "$STUB_LOG" 2>/dev/null || true)"
  if [[ -n "$line" ]]; then
    NX_STUB_BASE_URL="${line#STUB_BASE_URL=}"
    break
  fi
  kill -0 "$STUB_PID" 2>/dev/null || { echo "Tier B: stub exited early:" >&2; cat "$STUB_LOG" >&2; exit 1; }
  sleep 0.2
done

if [[ -z "$NX_STUB_BASE_URL" ]]; then
  echo "Tier B: stub did not announce STUB_BASE_URL:" >&2
  cat "$STUB_LOG" >&2
  exit 1
fi

case "$NX_STUB_BASE_URL" in
  http://127.*|http://localhost:*|http://*.local:*)
    echo "Tier B: stub bound loopback-ish ($NX_STUB_BASE_URL) — would false-green ATS" >&2
    exit 1 ;;
esac
# `xcodebuild test` does NOT propagate the shell env into the sandboxed
# XCUITest runner. The documented channel is the `TEST_RUNNER_` prefix:
# any env var named `TEST_RUNNER_<NAME>` in xcodebuild's environment is
# injected into the runner's environment as `<NAME>` (prefix stripped).
# IntegrationGateUITests reads `NX_STUB_BASE_URL` from
# ProcessInfo.environment.
export TEST_RUNNER_NX_STUB_BASE_URL="$NX_STUB_BASE_URL"
echo "Tier B: stub up at $NX_STUB_BASE_URL"

# --- 2. build + run the XCUITests (stripped entitlements, ad-hoc sign) ---
cd "$SWIFT_DIR"
xcodegen generate >/dev/null

# Run under explicit RC capture (not bare `set -e`) so a build break gets a
# clear failing-stage banner instead of an opaque abort (bd:nx-dr5f1). The
# xcodebuild output is inherited (not swallowed), and we exit with the real
# non-zero code so the gate fails for the right reason.
set +e
xcodebuild build-for-testing \
  -project nexus.xcodeproj -scheme nexus-mac -configuration Debug \
  -derivedDataPath "$DD" \
  CODE_SIGN_ENTITLEMENTS="$TEST_ENTITLEMENTS" \
  CODE_SIGN_IDENTITY="-" CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=YES
BUILD_RC=$?
set -e
if [[ "$BUILD_RC" -ne 0 ]]; then
  echo "Tier B FAILED at stage: build-for-testing" >&2
  exit "$BUILD_RC"
fi

# --- 3. run the XCUITests with graceful perms-timeout SKIP (bd:nx-4p2ov) ---
#
# Capture stdout+stderr so we can inspect for the specific
# "Timed out while enabling automation mode" failure signature. That
# signature means the parent terminal/Cursor lacks the macOS Accessibility
# / Automation perms that XCTest needs to drive the host app — a host
# environment issue, NOT a code regression. Treating it as SKIP (non-failing)
# lets the push proceed; treating any other failure as FAIL preserves the
# existing contract for real test regressions.
#
# The CC-specific signatures we recognise as "perms timeout":
#   - "Timed out while enabling automation mode"      (XCTest preflight)
#   - "Failed to initialize for UI testing"           (XCTest harness)
#   - "Test runner could not be attached"             (perms-blocked attach)
# All three resolve the same way: grant the terminal automation control
# under System Settings > Privacy & Security > Automation.
TEST_LOG="$(mktemp -t nx-tier-b-xcuitest.XXXXXX)"
TEST_LOGS+=("$TEST_LOG")  # cleanup() picks these up; see trap below

set +e
xcodebuild test-without-building \
  -project nexus.xcodeproj -scheme nexus-mac \
  -only-testing:nexus-mac-UITests/IntegrationGateUITests \
  -configuration Debug -derivedDataPath "$DD" \
  CODE_SIGN_ENTITLEMENTS="$TEST_ENTITLEMENTS" \
  CODE_SIGN_IDENTITY="-" CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=YES \
  2>&1 | tee "$TEST_LOG"
TEST_RC=${PIPESTATUS[0]}
set -e

if [[ "$TEST_RC" -ne 0 ]]; then
  if grep -qE "Timed out while enabling automation mode|Failed to initialize for UI testing|Test runner could not be attached" "$TEST_LOG"; then
    cat >&2 <<'PERMS_SKIP'

Tier B: SKIP — accessibility/automation perms missing for this terminal.

XCTest's automation mode requires the parent terminal (Terminal.app,
iTerm2, Cursor, etc.) to be granted control of System Events under:

  System Settings > Privacy & Security > Automation > <your terminal>
                                                       > System Events  (on)
  System Settings > Privacy & Security > Accessibility > <your terminal>  (on)

After granting, re-run the push. The integration gate is mandatory (no
whole-gate bypass), but you can skip just the fragile Tier B XCUITest run:
  SKIP_TIER_B_RUN=1 git push

Not a code regression — exiting 0 so the push can proceed.
PERMS_SKIP
    exit 0
  fi
  # Any other failure: propagate so real test regressions still abort the push.
  # Name the failing stage so a test regression is distinguishable from a build
  # break and from the perms-timeout SKIP above (bd:nx-dr5f1).
  echo "Tier B FAILED at stage: test-without-building" >&2
  exit "$TEST_RC"
fi
}

# --- run-if-main guard (bd:nx-cqd7k) -------------------------------------
# When executed directly, run the gate. When sourced (by the cleanup self-test),
# only the function/variable definitions above load — main() is never invoked.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
