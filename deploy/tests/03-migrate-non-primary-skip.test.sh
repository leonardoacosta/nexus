#!/usr/bin/env bash
#
# Self-test for deploy/hooks.d/post-merge/03-migrate (bd:nx-9k141 / task 4.7).
#
# Proves the primary-writer gate: a machine flagged NEXUS_DB_PRIMARY=false must
# SKIP db:migrate ENTIRELY (exit 0) even when the merge range DOES carry a
# packages/db/ schema change — rather than running db:migrate and failing loudly
# with "POSTGRES_URL is required" on every deploy.
#
# The hook is driven end-to-end inside an isolated temp git repo (with a real
# packages/db/ change between ORIG_HEAD and HEAD), an isolated HOME whose ~/.env
# carries the non-primary flag, and a `pnpm` stub on PATH that writes a marker
# iff invoked — so the "db:migrate never ran" claim is verified, not assumed.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$HERE/../hooks.d/post-merge/03-migrate"

fail() { echo "FAIL: $*" >&2; exit 1; }

[[ -f "$HOOK" ]] || fail "migrate hook not found at $HOOK"

WORK="$(mktemp -d -t nx-03-migrate.XXXXXX)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# ── Isolated HOME with the non-primary flag ────────────────────────────────
FAKE_HOME="$WORK/home"
mkdir -p "$FAKE_HOME"
cat > "$FAKE_HOME/.env" <<'EOF'
NEXUS_DB_PRIMARY=false
POSTGRES_URL=postgresql://should-not:matter@localhost:5999/unused
EOF

# ── pnpm stub: writes a marker iff db:migrate is ever invoked ───────────────
STUB_BIN="$WORK/bin"
mkdir -p "$STUB_BIN"
MIGRATE_MARKER="$WORK/pnpm-was-called"
cat > "$STUB_BIN/pnpm" <<EOF
#!/usr/bin/env bash
echo "PNPM STUB INVOKED: \$*" > "$MIGRATE_MARKER"
exit 0
EOF
chmod +x "$STUB_BIN/pnpm"

# ── Temp git repo carrying a packages/db/ change (ORIG_HEAD -> HEAD) ────────
REPO="$WORK/repo"
mkdir -p "$REPO"
(
  cd "$REPO"
  git init -q
  git config user.email t@t.test
  git config user.name t
  git config commit.gpgsign false
  mkdir -p packages/db/drizzle
  echo "-- base" > README.md
  git add README.md
  git commit -qm "base"
  ORIG="$(git rev-parse HEAD)"
  # A real schema change in the second commit.
  echo "ALTER TABLE x ADD COLUMN y int;" > packages/db/drizzle/9999_test.sql
  git add packages/db/drizzle/9999_test.sql
  git commit -qm "schema change"
  git update-ref ORIG_HEAD "$ORIG"
)

# ── Run the hook under the isolated env ────────────────────────────────────
set +e
OUT="$(cd "$REPO" && HOME="$FAKE_HOME" PATH="$STUB_BIN:$PATH" NEXUS_DB_PRIMARY= bash "$HOOK" 2>&1)"
CODE=$?
set -e

echo "── hook output ─────────────────────────────────────"
printf '%s\n' "$OUT"
echo "── exit code: $CODE ────────────────────────────────"

# Sanity: the hook must have detected the packages/db/ change (not the
# "no changes" early-skip) — otherwise this test would pass vacuously.
if printf '%s' "$OUT" | grep -q "no packages/db/ changes"; then
  fail "hook took the no-db-change early-skip — the packages/db/ change was not detected, test is vacuous"
fi

[[ "$CODE" -eq 0 ]] || fail "expected exit 0 (skip), got $CODE"

printf '%s' "$OUT" | grep -qi "non-primary machine, skipping db:migrate" \
  || fail "expected the non-primary skip message, got:\n$OUT"

[[ ! -f "$MIGRATE_MARKER" ]] \
  || fail "db:migrate WAS invoked (pnpm stub marker present) — the primary-writer gate did not short-circuit"

echo "PASS: 03-migrate skips db:migrate on a non-primary machine despite a packages/db/ change"
