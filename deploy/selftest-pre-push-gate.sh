#!/usr/bin/env bash
#
# Gate self-validation — add-fullstack-integration-test-gate task 3.2
# (nx-eneff). The capstone proving the whole spec's value END-TO-END
# through the REAL dispatcher (the actual `.git/hooks/pre-push`, which
# `deploy/install.sh:212` keeps byte-identical to
# `deploy/hooks/pre-push-dispatcher`).
#
# This drives the dispatcher EXACTLY as `git push` would: per the git
# pre-push protocol the hook is invoked with args `<remote> <url>` and
# fed ref lines on stdin as
#   <local ref> <local sha> <remote ref> <remote sha>
# Feeding a `refs/heads/main` ref line is what flips 01-deploy's
# PUSHING_MAIN guard, so the integration gate actually runs.
#
# Three cases:
#   (a) ABORT  — a seeded Tier A failure makes 01-deploy fail; assert
#                the dispatcher exits NON-ZERO *and* that it was the
#                `# nexus:blocking` propagation (not an incidental exit).
#   (b) SKIP   — forced-headless env: assert 01-deploy emits the
#                `SKIP Tier B` marker AND the dispatcher exits 0
#                (a skip is not a failure).
#   (c) CLEAN  — no seed, GUI present (if any): dispatcher exits 0.
#
# DESIGN NOTE. This validates the *gate orchestration* — the dispatcher's
# blocking propagation and the gate's skip-marker logic — NOT the Tier A
# / Tier B suites themselves (those have their own runtime-verified
# tasks 1.x / 2.x). The heavyweight Tier A/B commands (`pnpm test`,
# bundle-integrity, `xcodebuild`, the XCUITest runner) are neutralised
# via PATH shims + the gate's own documented SKIP_* env vars so the
# self-test is fast and deterministic. The path that matters —
# dispatcher -> 01-deploy -> fail() -> `# nexus:blocking` -> non-zero
# dispatcher exit — is exercised 100% for real.
#
# Self-cleaning: every mutation (PATH-shim dir, temp stdin/log files)
# is removed by an EXIT trap even on early failure. No tracked file is
# modified; nothing is staged.

set -uo pipefail

GREEN='\033[1;32m'; YELLOW='\033[1;33m'; RED='\033[1;31m'; RESET='\033[0m'
ok()   { printf "${GREEN}selftest: %s${RESET}\n" "$1"; }
note() { printf "${YELLOW}selftest: %s${RESET}\n" "$1"; }
err()  { printf "${RED}selftest: %s${RESET}\n" "$1" >&2; }

REPO_DIR="$(git rev-parse --show-toplevel)"
DISPATCHER="$REPO_DIR/.git/hooks/pre-push"
if [[ ! -x "$DISPATCHER" ]]; then
    # Fall back to the canonical source if the hook is not installed.
    DISPATCHER="$REPO_DIR/deploy/hooks/pre-push-dispatcher"
fi
[[ -x "$DISPATCHER" ]] || { err "no executable dispatcher found (.git/hooks/pre-push or deploy/hooks/pre-push-dispatcher)"; exit 1; }

WORK="$(mktemp -d -t nx-gate-selftest.XXXXXX)"
SHIM_DIR="$WORK/shim"
mkdir -p "$SHIM_DIR"

cleanup() {
    rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# A ref line shaped exactly like git's pre-push stdin for a push to main.
# (sha values are irrelevant — 01-deploy only matches the remote ref.)
ZERO=0000000000000000000000000000000000000000
HEAD_SHA="$(git rev-parse HEAD 2>/dev/null || echo "$ZERO")"
REF_LINE="refs/heads/main $HEAD_SHA refs/heads/main $ZERO"

# ----------------------------------------------------------------------
# Shim helpers. We prepend $SHIM_DIR to PATH so the gate's `pnpm`,
# `xcodebuild`, `xcodegen`, `bun` resolve to our throwaway stand-ins.
# ----------------------------------------------------------------------
make_shim() {  # name, exit_code, [echo line]
    local name="$1" code="$2" line="${3:-}"
    {
        printf '#!/usr/bin/env bash\n'
        # Single-quote the literal so parens/specials in the message
        # can never re-enter the shell parser.
        [[ -n "$line" ]] && printf "printf '%%s\\\\n' %q\n" "$line"
        printf 'exit %s\n' "$code"
    } >"$SHIM_DIR/$name"
    chmod +x "$SHIM_DIR/$name"
}

clear_shims() { rm -f "$SHIM_DIR"/* 2>/dev/null || true; }

# Run the dispatcher exactly as git would: args = remote + url, ref line
# on stdin. Captures combined output + exit code. Extra env via KEY=VAL
# args after the first two positional slots.
run_dispatcher() {  # outfile, env...
    local outfile="$1"; shift
    local rc
    (
        export PATH="$SHIM_DIR:$PATH"
        for kv in "$@"; do export "$kv"; done
        printf '%s\n' "$REF_LINE" | "$DISPATCHER" origin "file://$REPO_DIR" >"$outfile" 2>&1
    )
    rc=$?
    return $rc
}

FAILED=0

# ======================================================================
# (a) ABORT — seeded Tier A failure must propagate as non-zero dispatcher
#     exit via the `# nexus:blocking` opt-in.
# ======================================================================
note "=== case (a): seeded Tier A failure -> dispatcher MUST abort ==="
clear_shims
# `pnpm` is the FIRST Tier A command 01-deploy runs:
#   (cd "$REPO_DIR" && pnpm test) || fail "Tier A: turbo test failed ..."
# A `pnpm` that exits non-zero makes Tier A fail fast (milliseconds),
# 01-deploy calls fail() (exit 1), the dispatcher greps the
# `# nexus:blocking` sentinel and propagates the non-zero exit.
make_shim pnpm 1 "SELFTEST-SEED: forced Tier A failure (throwaway pnpm shim)"

OUT_A="$WORK/out_a.txt"
if run_dispatcher "$OUT_A" "SKIP_CROSSHOST_SMOKE=1"; then
    rc_a=0
else
    rc_a=$?
fi

echo "----- dispatcher output (case a) -----"
cat "$OUT_A"
echo "----- dispatcher exit code (case a): $rc_a -----"

BLOCK_LINE="$(grep -F "failed (blocking — push will abort)" "$OUT_A" || true)"
if [[ "$rc_a" -ne 0 ]] && [[ -n "$BLOCK_LINE" ]]; then
    ok "(a) PASS — dispatcher exited $rc_a (non-zero) AND blocking-propagation line present:"
    printf '       %s\n' "$BLOCK_LINE"
else
    err "(a) FAIL — expected non-zero exit + blocking-propagation line."
    err "    exit=$rc_a  blocking_line='${BLOCK_LINE:-<absent>}'"
    FAILED=1
fi

# Revert the seed fully before the next case.
clear_shims
ok "(a) seed reverted (shim dir emptied)"

# ======================================================================
# (b) HEADLESS SKIP — forced-headless env: 01-deploy must emit a
#     `SKIP Tier B` marker and the dispatcher must exit 0.
# ======================================================================
note "=== case (b): forced-headless -> SKIP Tier B, dispatcher exit 0 ==="
clear_shims
# Cheap-pass Tier A so the gate reaches the Tier B GUI probe quickly.
make_shim pnpm 0
make_shim xcodebuild 0
make_shim xcodegen 0
make_shim bun 0

OUT_B="$WORK/out_b.txt"
# SSH_CONNECTION set => 01-deploy treats the host as headless even on
# macOS (line ~116). SKIP_BUNDLE_INTEGRITY uses the gate's own escape
# hatch so the bundle check (invoked by absolute path, not PATH) no-ops.
if run_dispatcher "$OUT_B" \
        "SSH_CONNECTION=selftest 1 2 3" \
        "SKIP_BUNDLE_INTEGRITY=1" \
        "SKIP_CROSSHOST_SMOKE=1"; then
    rc_b=0
else
    rc_b=$?
fi

echo "----- dispatcher output (case b) -----"
cat "$OUT_B"
echo "----- dispatcher exit code (case b): $rc_b -----"

SKIP_LINE="$(grep -F "SKIP Tier B" "$OUT_B" || true)"
if [[ "$rc_b" -eq 0 ]] && [[ -n "$SKIP_LINE" ]]; then
    ok "(b) PASS — dispatcher exited 0 AND SKIP Tier B marker present:"
    printf '       %s\n' "$SKIP_LINE"
else
    err "(b) FAIL — expected exit 0 + 'SKIP Tier B' marker."
    err "    exit=$rc_b  skip_line='${SKIP_LINE:-<absent>}'"
    FAILED=1
fi
clear_shims

# ======================================================================
# (c) CLEAN — no seed, GUI present (if this host has one): exit 0.
#     On a headless host this degrades to the same SKIP path as (b);
#     on a GUI host the Tier B runner is short-circuited via its own
#     documented SKIP_TIER_B_RUN escape hatch (the full XCUITest suite
#     is runtime-verified by tasks 2.2-2.4 — out of scope for a gate
#     orchestration self-test). Either way a clean run MUST exit 0.
# ======================================================================
note "=== case (c): no seed, GUI as-is -> dispatcher exit 0 ==="
clear_shims
make_shim pnpm 0
make_shim xcodebuild 0
make_shim xcodegen 0

OUT_C="$WORK/out_c.txt"
if run_dispatcher "$OUT_C" \
        "SKIP_BUNDLE_INTEGRITY=1" \
        "SKIP_TIER_B_RUN=1" \
        "SKIP_CROSSHOST_SMOKE=1"; then
    rc_c=0
else
    rc_c=$?
fi

echo "----- dispatcher output (case c) -----"
cat "$OUT_C"
echo "----- dispatcher exit code (case c): $rc_c -----"

if [[ "$rc_c" -eq 0 ]]; then
    GUI_NOTE="$(grep -F "SKIP Tier B (headless)" "$OUT_C" >/dev/null 2>&1 && echo "headless (Tier B skipped by GUI guard)" || echo "GUI present (Tier B short-circuited via SKIP_TIER_B_RUN)")"
    ok "(c) PASS — clean run exited 0 [$GUI_NOTE]"
else
    err "(c) FAIL — expected exit 0 on a clean run; got $rc_c"
    FAILED=1
fi
clear_shims

# ======================================================================
echo
if [[ "$FAILED" -eq 0 ]]; then
    ok "ALL CASES PASSED — gate self-validation green (a abort / b skip / c clean)"
    exit 0
else
    err "SELF-VALIDATION FAILED — see case output above"
    exit 1
fi
