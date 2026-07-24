#!/usr/bin/env bash
#
# Self-test for deploy/hooks.d/post-merge/02-deploy lockfile-drift handling
# (bd:nx-zpbqi origin / bd:nx-pt24w contract update via converge-package-manager).
#
# converge-package-manager (nx-4vuh1) removed the non-frozen auto-recovery
# branch: CI now carries a second-lockfile guard and pnpm is gone, so a
# frozen-install failure means bun.lock genuinely drifted from what CI
# validated — that should never reach deploy. The hook must now HARD FAIL
# immediately on `bun install --frozen-lockfile` failure: no non-frozen
# retry, no `git checkout -- bun.lock`, no socat alert, and it must never
# reach the build step or systemctl.

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

# ── bun stub: frozen install FAILS (drift). Anything else should never run. ─
STUB_BIN="$WORK/bin"
mkdir -p "$STUB_BIN"
BUN_LOG="$WORK/bun-calls.log"
cat > "$STUB_BIN/bun" <<EOF
#!/usr/bin/env bash
echo "bun \$*" >> "$BUN_LOG"
case "\$*" in
  "install --frozen-lockfile") exit 1 ;;   # simulate lockfile drift
  "run build")                 exit 1 ;;   # would-be safe stop point — must not be reached
  *)                           exit 0 ;;
esac
EOF
chmod +x "$STUB_BIN/bun"

# Defensive stub: systemctl must never run against the real host.
cat > "$STUB_BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
echo "REFUSED: systemctl invoked in test" >&2
exit 97
EOF
chmod +x "$STUB_BIN/systemctl"

# ── Temp git repo (apps/agent present so a would-be build `cd` would succeed) ─
# deploy/lib/*.sh is copied in because the hook sources remote-agents.sh +
# deploy-retry.sh via `$REPO_DIR/deploy/lib/...` (REPO_DIR = git toplevel of
# wherever it runs) BEFORE the frozen-install step even runs — without this,
# sourcing fails first and the drift path under test is never reached. This
# gap predates converge-package-manager (introduced by 8a5b77f1, 2026-07-16)
# and is fixed here as part of this test's update, not carried over broken.
REPO="$WORK/repo"
mkdir -p "$REPO/apps/agent" "$REPO/deploy/lib"
cp "$HERE/../lib/remote-agents.sh" "$HERE/../lib/deploy-retry.sh" "$REPO/deploy/lib/"
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

# The frozen install must have been attempted.
grep -q "install --frozen-lockfile" "$BUN_LOG" || fail "frozen-lockfile install was never attempted"

# No non-frozen recovery retry — that branch is gone.
grep -qx "bun install" "$BUN_LOG" && fail "non-frozen recovery install ran, but the recovery branch was removed"

# Hook must exit non-zero and hard-fail with an actionable message.
[[ "$CODE" -ne 0 ]] || fail "hook exited 0 on lockfile drift — expected a hard failure"
printf '%s' "$OUT" | grep -qi "frozen-lockfile failed" \
  || fail "expected the hard-fail lockfile-drift message, got:\n$OUT"
printf '%s' "$OUT" | grep -qi "regenerate locally" \
  || fail "expected actionable regenerate-locally guidance, got:\n$OUT"

# No silent-recovery language should ever appear again.
printf '%s' "$OUT" | grep -qi "recovery succeeded" \
  && fail "hook still reports 'recovery succeeded' — recovery branch should be gone"
printf '%s' "$OUT" | grep -qi "UPSTREAM ACTION REQUIRED" \
  && fail "hook still emits the old recovery alert — recovery branch should be gone"

# The hook must NOT reach the build step or a successful deploy.
grep -q "run build" "$BUN_LOG" \
  && fail "build step ran despite frozen-install failure — hook did not stop early"
printf '%s' "$OUT" | grep -qi "deploy complete" \
  && fail "hook reported 'deploy complete' despite a failed frozen install"

# And it must never have reached systemctl.
printf '%s' "$OUT" | grep -q "REFUSED: systemctl" \
  && fail "hook reached systemctl — hard-fail stop point did not hold"

echo "PASS: 02-deploy hard-fails immediately on lockfile drift (no silent recovery)"
