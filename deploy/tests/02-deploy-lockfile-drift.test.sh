#!/usr/bin/env bash
#
# Self-test for deploy/hooks.d/post-merge/02-deploy lockfile-drift recovery
# (bd:nx-zpbqi / task 4.6).
#
# Proves the frozen-install recovery branch: when `bun install --frozen-lockfile`
# fails (committed bun.lock has drifted from what bun resolves), the hook must
#   1. attempt a non-frozen `bun install` to refresh node_modules, and
#   2. surface an ACTIONABLE, non-silent alert ("UPSTREAM ACTION REQUIRED —
#      regenerate + commit bun.lock") rather than leaving the agent on stale deps
#      or failing silently.
#
# The hook is driven end-to-end inside an isolated temp git repo with a `bun`
# stub on PATH that fails the frozen install, succeeds the non-frozen install,
# then fails `run build` — a deliberate, SAFE stop point that halts the hook at
# `fail "agent build failed"` BEFORE it reaches `systemctl --user` (which would
# touch the real host). The recovery branch runs to completion first, so its
# actionable-alert output is observable.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$HERE/../hooks.d/post-merge/02-deploy"

fail() { echo "FAIL: $*" >&2; exit 1; }

[[ -f "$HOOK" ]] || fail "deploy hook not found at $HOOK"

WORK="$(mktemp -d -t nx-02-deploy.XXXXXX)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

FAKE_HOME="$WORK/home"
mkdir -p "$FAKE_HOME"

# ── bun stub: frozen install FAILS, non-frozen SUCCEEDS, build FAILS ────────
STUB_BIN="$WORK/bin"
mkdir -p "$STUB_BIN"
BUN_LOG="$WORK/bun-calls.log"
cat > "$STUB_BIN/bun" <<EOF
#!/usr/bin/env bash
echo "bun \$*" >> "$BUN_LOG"
case "\$*" in
  "install --frozen-lockfile") exit 1 ;;   # simulate lockfile drift
  "install")                   exit 0 ;;   # non-frozen recovery succeeds
  "run build")                 exit 1 ;;   # safe stop point (before systemctl)
  *)                           exit 0 ;;
esac
EOF
chmod +x "$STUB_BIN/bun"

# Defensive stub: systemctl must never run against the real host even if the
# hook somehow reaches it (it should not — build fails first).
cat > "$STUB_BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
echo "REFUSED: systemctl invoked in test" >&2
exit 97
EOF
chmod +x "$STUB_BIN/systemctl"

# ── Temp git repo (apps/agent present so the build `cd` succeeds) ───────────
REPO="$WORK/repo"
mkdir -p "$REPO/apps/agent"
(
  cd "$REPO"
  git init -q
  git config user.email t@t.test
  git config user.name t
  git config commit.gpgsign false
  echo "base" > README.md
  git add README.md
  git commit -qm "base"
)

# ── Run the hook with --force (skips the git-diff code-change gate) ─────────
set +e
OUT="$(cd "$REPO" && HOME="$FAKE_HOME" PATH="$STUB_BIN:$PATH" bash "$HOOK" --force 2>&1)"
CODE=$?
set -e

echo "── hook output ─────────────────────────────────────"
printf '%s\n' "$OUT"
echo "── exit code: $CODE ────────────────────────────────"
echo "── bun calls ───────────────────────────────────────"
cat "$BUN_LOG" 2>/dev/null || echo "(none)"
echo "────────────────────────────────────────────────────"

# The frozen install must have been attempted AND the non-frozen recovery too.
grep -q "install --frozen-lockfile" "$BUN_LOG" || fail "frozen-lockfile install was never attempted"
grep -qx "bun install" "$BUN_LOG" || fail "non-frozen recovery install was never attempted"

# Actionable, non-silent alert must be surfaced.
printf '%s' "$OUT" | grep -qi "frozen-lockfile install failed" \
  || fail "expected the frozen-lockfile-drift warning, got:\n$OUT"
printf '%s' "$OUT" | grep -qi "recovery succeeded" \
  || fail "expected recovery-succeeded signal, got:\n$OUT"
printf '%s' "$OUT" | grep -qi "UPSTREAM ACTION REQUIRED" \
  || fail "expected the actionable 'UPSTREAM ACTION REQUIRED' alert, got:\n$OUT"

# The hook must NOT silently continue to a successful deploy on drift+build-fail.
printf '%s' "$OUT" | grep -qi "deploy complete" \
  && fail "hook reported 'deploy complete' despite a failed build — should have stopped"

# And it must never have reached systemctl.
printf '%s' "$OUT" | grep -q "REFUSED: systemctl" \
  && fail "hook reached systemctl — build-fail stop point did not hold"

echo "PASS: 02-deploy recovers from lockfile drift and surfaces an actionable upstream alert"
