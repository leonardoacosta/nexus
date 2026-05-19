#!/usr/bin/env bash
set -euo pipefail

# Bundle-integrity check (add-fullstack-integration-test-gate task 1.5).
#
# Builds the macOS dashboard via `xcodebuild` DIRECTLY — never install.sh,
# which silently no-ops on this fault class (nx-5ws74) — then asserts the
# produced bundle is well-formed:
#
#   1. The product is named `nexus.app` (PRODUCT_NAME drift guard).
#   2. Its Info.plist contains `NSAppTransportSecurity` (the ATS allowance
#      that the -1022 cleartext incident hinged on — nx-p2zs5 regression
#      class).
#   3. Its Info.plist contains `LSUIElement` (menu-bar agent app; a missing
#      key turns it into a Dock app — UI regression class).
#
# This guards the nx-5ws74 silent-no-op + ATS-config regression classes.
# It does NOT fix them — it asserts the built artifact directly.
#
# Usage:
#   deploy/check-bundle-integrity.sh
#
# Env:
#   NX_BUNDLE_DERIVED_DATA   override the derivedData path
#                            (default: /tmp/nx-cap/itg-build)
#   SKIP_BUNDLE_INTEGRITY=1  skip the check entirely (escape hatch, matches
#                            the pre-push hook's SKIP_DEPLOY convention)

GREEN='\033[1;32m'
YELLOW='\033[1;33m'
RED='\033[1;31m'
RESET='\033[0m'

info() { printf "${GREEN}bundle-integrity: %s${RESET}\n" "$1"; }
skip() { printf "${YELLOW}bundle-integrity: %s${RESET}\n" "$1"; }
fail() { printf "${RED}bundle-integrity: %s${RESET}\n" "$1" >&2; exit 1; }

if [[ "${SKIP_BUNDLE_INTEGRITY:-0}" == "1" ]]; then
    skip "SKIP_BUNDLE_INTEGRITY set, bypassing bundle-integrity check"
    exit 0
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
    skip "not macOS — Swift bundle cannot be built here, skipping"
    exit 0
fi

REPO_DIR="$(git rev-parse --show-toplevel)"
SWIFT_DIR="$REPO_DIR/apps/swift"
PROJECT="$SWIFT_DIR/nexus.xcodeproj"
SCHEME="nexus-mac"
DERIVED="${NX_BUNDLE_DERIVED_DATA:-/tmp/nx-cap/itg-build}"

[[ -d "$PROJECT" ]] || fail "xcodeproj not found at $PROJECT (run xcodegen first)"

info "building $SCHEME (Release, code-signing disabled) -> $DERIVED"
rm -rf "$DERIVED"
xcodebuild \
    -project "$PROJECT" \
    -scheme "$SCHEME" \
    -configuration Release \
    -derivedDataPath "$DERIVED" \
    CODE_SIGN_IDENTITY="" \
    CODE_SIGNING_REQUIRED=NO \
    CODE_SIGNING_ALLOWED=NO \
    build \
    >/tmp/nx-bundle-integrity-xcodebuild.log 2>&1 \
    || { tail -40 /tmp/nx-bundle-integrity-xcodebuild.log >&2; fail "xcodebuild failed (see log above)"; }

APP_PATH="$DERIVED/Build/Products/Release/nexus.app"

# Assertion 1: the product is named nexus.app.
if [[ ! -d "$APP_PATH" ]]; then
    found="$(find "$DERIVED/Build/Products/Release" -maxdepth 1 -name '*.app' -print 2>/dev/null | head -1)"
    fail "expected product 'nexus.app' at $APP_PATH; found instead: ${found:-<none>}"
fi
info "product is nexus.app -> $APP_PATH"

PLIST="$APP_PATH/Contents/Info.plist"
[[ -f "$PLIST" ]] || fail "Info.plist missing at $PLIST"

PB=/usr/libexec/PlistBuddy

# Assertion 2: NSAppTransportSecurity present.
if ! "$PB" -c "Print :NSAppTransportSecurity" "$PLIST" >/tmp/nx-bi-ats.txt 2>&1; then
    cat /tmp/nx-bi-ats.txt >&2
    fail "Info.plist missing NSAppTransportSecurity (ATS-config regression — nx-p2zs5)"
fi
info "NSAppTransportSecurity present:"
sed 's/^/    /' /tmp/nx-bi-ats.txt

# Assertion 3: LSUIElement present.
if ! "$PB" -c "Print :LSUIElement" "$PLIST" >/tmp/nx-bi-uielement.txt 2>&1; then
    cat /tmp/nx-bi-uielement.txt >&2
    fail "Info.plist missing LSUIElement (would become a Dock app, not a menu-bar agent)"
fi
info "LSUIElement present: $(cat /tmp/nx-bi-uielement.txt)"

info "OK — bundle integrity verified (nexus.app + NSAppTransportSecurity + LSUIElement)"
