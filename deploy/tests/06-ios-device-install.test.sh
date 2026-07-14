#!/usr/bin/env bash
#
# E2E harness for the post-merge iOS-device deploy dispatcher's automatic-install
# contract (bd:nx-td5tq — "installs nexus-ios to a paired device with no manual
# devicectl intervention").
#
# Drives the REAL production library deploy/lib/ios-device-deploy.sh through its
# public entry point ios_device_deploy_run in FORCED-INLINE mode
# (NX_IOS_DEPLOY_MODE=inline), which is the exact path 06-ios-deploy invokes once
# it is inside the Aqua session. The whole macOS toolchain
# (xcodegen/xcodebuild/codesign/xcrun/uname) is replaced by PATH-injected stubs so
# the flow runs to completion on Linux (or any host) WITHOUT a physical device,
# an Xcode install, or a real signed build — the committed test never depends on
# hardware being present, which is the requirement for it to run in CI / on the
# homelab.
#
# Why this is the meaningful assertion (not a live device flash): the behavior
# under test is the DISPATCHER's — that a merge touching nexus-ios ultimately
# reaches `xcrun devicectl device install app --device <UDID> <app>` with a
# concrete, automatically-resolved device UUID and a concrete .app bundle path,
# with no step that reads stdin (every case runs with stdin closed, </dev/null,
# and still completes). A resolved `--device <UUID>` argument is the proof of "no
# manual intervention": devicectl is handed the target directly, never an
# interactive device picker.
#
# Contract proven:
#   1. default UDID — no args -> install invoked with NX_IOS_DEFAULT_UDID + a
#      *.app path; run returns 0; a best-effort launch is also invoked.
#   2. --device override — install targets the passed UDID, not the default.
#   3. NX_IOS_DEVICE_UDID env — install targets the env UDID.
#   4. build failure — a failed xcodebuild means devicectl install is NEVER
#      called and the run returns 1 (no stale/failed bundle pushed to a device).
#   5. wrong-team signing — a bundle not signed by team DX3Y367L2A is refused
#      before any device contact (install NEVER called), run returns 1.
#   6. launch is best-effort — install OK but `process launch` failing still
#      returns 0 (install is the contractual step; launch is not).
#
# No sibling test covers ios-device-deploy.sh's install dispatch; post-merge-
# hook-order.test.sh only proves 06-ios-deploy is wired into the chain and is
# non-blocking, never that it resolves a device and installs automatically.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$HERE/../lib/ios-device-deploy.sh"

# The default UDID the lib falls back to when neither --device nor
# NX_IOS_DEVICE_UDID is supplied. Kept in sync with ios-device-deploy.sh.
EXPECTED_DEFAULT_UDID="1AE26465-387A-5B3F-9012-4CF29A9B3AFB"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[[ -f "$LIB" ]] || fail "library not found at $LIB"

# Guard against drift: the default UDID this test asserts must match the lib's.
grep -q "NX_IOS_DEFAULT_UDID=\"$EXPECTED_DEFAULT_UDID\"" "$LIB" \
  || fail "default UDID in test ($EXPECTED_DEFAULT_UDID) no longer matches ios-device-deploy.sh — update the test"

WORK="$(mktemp -d -t nx-ios-install-test.XXXXXX)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# ── Build the macOS-toolchain stub bin dir (prepended to PATH per case) ──
# Each stub records what it was asked to do into $NX_TEST_REC and honors a few
# NX_TEST_* knobs so a single stub set drives every case.
STUB_BIN="$WORK/bin"
mkdir -p "$STUB_BIN"

cat >"$STUB_BIN/uname" <<'EOF'
#!/usr/bin/env bash
# Force the lib's Darwin gate to pass regardless of the real host OS.
echo Darwin
EOF

cat >"$STUB_BIN/xcodegen" <<'EOF'
#!/usr/bin/env bash
# Benign success; must NOT emit "Spec validation"/"invalid dependency".
echo "stub xcodegen: generated project"
exit 0
EOF

cat >"$STUB_BIN/xcodebuild" <<'EOF'
#!/usr/bin/env bash
# On success, materialize the .app the lib will `find` under -derivedDataPath,
# so the real find(1) locates a genuine bundle dir. Honor NX_TEST_XCODEBUILD_RC.
dd=""; prev=""
for a in "$@"; do
  [[ "$prev" == "-derivedDataPath" ]] && dd="$a"
  prev="$a"
done
rc="${NX_TEST_XCODEBUILD_RC:-0}"
if [[ "$rc" -eq 0 && -n "$dd" ]]; then
  mkdir -p "$dd/Build/Products/Debug-iphoneos/nexus.app"
fi
echo "stub xcodebuild: rc=$rc"
exit "$rc"
EOF

cat >"$STUB_BIN/codesign" <<'EOF'
#!/usr/bin/env bash
# Mimic `codesign -dv --verbose=2` output on stderr (the lib merges 2>&1).
printf 'Executable=stub\nTeamIdentifier=%s\n' "${NX_TEST_CODESIGN_TEAM:-DX3Y367L2A}" >&2
exit 0
EOF

cat >"$STUB_BIN/xcrun" <<'EOF'
#!/usr/bin/env bash
# Record devicectl install/launch invocations verbatim; honor RC knobs.
if [[ "$1" == "devicectl" && "$2" == "device" && "$3" == "install" && "$4" == "app" ]]; then
  printf '%s\n' "$*" >> "$NX_TEST_REC/install.argv"
  echo "stub devicectl install"
  exit "${NX_TEST_INSTALL_RC:-0}"
fi
if [[ "$1" == "devicectl" && "$2" == "device" && "$3" == "process" && "$4" == "launch" ]]; then
  printf '%s\n' "$*" >> "$NX_TEST_REC/launch.argv"
  echo "stub devicectl launch"
  exit "${NX_TEST_LAUNCH_RC:-0}"
fi
# Any other xcrun use (e.g. list devices) is a harmless no-op here.
exit 0
EOF

# launchctl/osascript aren't hit on the inline path, but stub them so a stray
# call (e.g. a failure banner) can never touch the real GUI session.
cat >"$STUB_BIN/launchctl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat >"$STUB_BIN/osascript" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

chmod +x "$STUB_BIN"/*

# ── Case driver ─────────────────────────────────────────────────────
# Runs ios_device_deploy_run inline, with stubs on PATH and stdin CLOSED
# (</dev/null) to prove nothing blocks on interactive input. Echoes RESULT plus
# the recorded install/launch argv for the parent to assert on.
run_case() {
  local case_name="$1"; shift
  local rec="$WORK/$case_name.rec"
  mkdir -p "$rec"

  # Per-case behavior knobs (defaults = happy path).
  local xcb_rc="${CASE_XCODEBUILD_RC:-0}"
  local team="${CASE_CODESIGN_TEAM:-DX3Y367L2A}"
  local install_rc="${CASE_INSTALL_RC:-0}"
  local launch_rc="${CASE_LAUNCH_RC:-0}"

  local result
  set +e
  env \
    PATH="$STUB_BIN:$PATH" \
    NX_TEST_REC="$rec" \
    NX_TEST_XCODEBUILD_RC="$xcb_rc" \
    NX_TEST_CODESIGN_TEAM="$team" \
    NX_TEST_INSTALL_RC="$install_rc" \
    NX_TEST_LAUNCH_RC="$launch_rc" \
    NX_IOS_DEPLOY_MODE=inline \
    ${CASE_DEVICE_ENV:+NX_IOS_DEVICE_UDID="$CASE_DEVICE_ENV"} \
    /usr/bin/env bash -c '
      set -uo pipefail
      source "'"$LIB"'"
      if ios_device_deploy_run "$@"; then echo "RESULT=0"; else echo "RESULT=1"; fi
    ' _ "$@" </dev/null >"$rec/out.txt" 2>"$rec/err.txt"
  set -e

  result="$(sed -n 's/^RESULT=//p' "$rec/out.txt")"
  echo "RESULT=$result"
  echo "INSTALL_COUNT=$( [[ -f "$rec/install.argv" ]] && wc -l <"$rec/install.argv" | tr -d ' ' || echo 0 )"
  echo "INSTALL_ARGV=$( [[ -f "$rec/install.argv" ]] && cat "$rec/install.argv" || true )"
  echo "LAUNCH_COUNT=$( [[ -f "$rec/launch.argv" ]] && wc -l <"$rec/launch.argv" | tr -d ' ' || echo 0 )"
}

# ── Case 1: default UDID, happy path ─────────────────────────────────
OUT="$(run_case default)"
RESULT="$(printf '%s\n' "$OUT" | sed -n 's/^RESULT=//p')"
ICOUNT="$(printf '%s\n' "$OUT" | sed -n 's/^INSTALL_COUNT=//p')"
IARGV="$(printf '%s\n' "$OUT" | sed -n 's/^INSTALL_ARGV=//p')"
LCOUNT="$(printf '%s\n' "$OUT" | sed -n 's/^LAUNCH_COUNT=//p')"
[[ "$RESULT" == "0" ]] || fail "default: expected RESULT=0, got '$RESULT' (err: $(cat "$WORK/default.rec/err.txt"))"
[[ "$ICOUNT" == "1" ]] || fail "default: expected exactly 1 devicectl install, got '$ICOUNT'"
case "$IARGV" in
  *"--device $EXPECTED_DEFAULT_UDID"*) : ;;
  *) fail "default: install did not target the default UDID; argv: $IARGV" ;;
esac
case "$IARGV" in
  *"nexus.app"*) : ;;
  *) fail "default: install did not receive a nexus.app bundle path; argv: $IARGV" ;;
esac
[[ "$LCOUNT" == "1" ]] || fail "default: expected a best-effort launch to be invoked, got '$LCOUNT'"
echo "ok: default -> auto-resolved --device $EXPECTED_DEFAULT_UDID, installed *.app, launched (no stdin)"

# ── Case 2: --device override ────────────────────────────────────────
OVERRIDE_UDID="TEST-OVERRIDE-UDID-0002"
OUT="$(run_case override --device "$OVERRIDE_UDID")"
RESULT="$(printf '%s\n' "$OUT" | sed -n 's/^RESULT=//p')"
IARGV="$(printf '%s\n' "$OUT" | sed -n 's/^INSTALL_ARGV=//p')"
[[ "$RESULT" == "0" ]] || fail "override: expected RESULT=0, got '$RESULT'"
case "$IARGV" in
  *"--device $OVERRIDE_UDID"*) : ;;
  *) fail "override: install did not target the --device UDID; argv: $IARGV" ;;
esac
case "$IARGV" in
  *"$EXPECTED_DEFAULT_UDID"*) fail "override: install still carried the DEFAULT UDID; argv: $IARGV" ;;
  *) : ;;
esac
echo "ok: --device override -> install targeted $OVERRIDE_UDID, not the default"

# ── Case 3: NX_IOS_DEVICE_UDID env ───────────────────────────────────
ENV_UDID="TEST-ENV-UDID-0003"
OUT="$(CASE_DEVICE_ENV="$ENV_UDID" run_case env)"
RESULT="$(printf '%s\n' "$OUT" | sed -n 's/^RESULT=//p')"
IARGV="$(printf '%s\n' "$OUT" | sed -n 's/^INSTALL_ARGV=//p')"
[[ "$RESULT" == "0" ]] || fail "env: expected RESULT=0, got '$RESULT'"
case "$IARGV" in
  *"--device $ENV_UDID"*) : ;;
  *) fail "env: install did not target NX_IOS_DEVICE_UDID; argv: $IARGV" ;;
esac
echo "ok: NX_IOS_DEVICE_UDID -> install targeted $ENV_UDID"

# ── Case 4: build failure -> no install, RESULT=1 ────────────────────
OUT="$(CASE_XCODEBUILD_RC=65 run_case buildfail)"
RESULT="$(printf '%s\n' "$OUT" | sed -n 's/^RESULT=//p')"
ICOUNT="$(printf '%s\n' "$OUT" | sed -n 's/^INSTALL_COUNT=//p')"
[[ "$RESULT" == "1" ]] || fail "buildfail: expected RESULT=1 (build failed), got '$RESULT'"
[[ "$ICOUNT" == "0" ]] || fail "buildfail: devicectl install was called on a FAILED build (count=$ICOUNT)"
echo "ok: build failure -> devicectl install never called, RESULT=1"

# ── Case 5: wrong-team signing -> no install, RESULT=1 ───────────────
OUT="$(CASE_CODESIGN_TEAM=WRONGTEAM99 run_case wrongteam)"
RESULT="$(printf '%s\n' "$OUT" | sed -n 's/^RESULT=//p')"
ICOUNT="$(printf '%s\n' "$OUT" | sed -n 's/^INSTALL_COUNT=//p')"
[[ "$RESULT" == "1" ]] || fail "wrongteam: expected RESULT=1 (signing refused), got '$RESULT'"
[[ "$ICOUNT" == "0" ]] || fail "wrongteam: devicectl install was called on a wrongly-signed bundle (count=$ICOUNT)"
echo "ok: wrong-team signing -> refused before device contact, RESULT=1"

# ── Case 6: launch best-effort -> install OK + launch fail = RESULT 0 ─
OUT="$(CASE_LAUNCH_RC=1 run_case launchfail)"
RESULT="$(printf '%s\n' "$OUT" | sed -n 's/^RESULT=//p')"
ICOUNT="$(printf '%s\n' "$OUT" | sed -n 's/^INSTALL_COUNT=//p')"
[[ "$RESULT" == "0" ]] || fail "launchfail: expected RESULT=0 (launch is best-effort), got '$RESULT'"
[[ "$ICOUNT" == "1" ]] || fail "launchfail: expected install to have run once, got '$ICOUNT'"
echo "ok: launch failure after a good install -> RESULT=0 (launch is best-effort)"

echo "PASS: 06-ios-device install dispatcher — auto device-UUID resolution + non-interactive install contract"
