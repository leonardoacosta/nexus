#!/usr/bin/env bash
# lint-sql-safety.sh — CI grep guard against raw SQL interpolation patterns.
# Scans apps/ and packages/ for dangerous SQL string concatenation.
# Lines annotated with "// SAFE:" are excluded.
# Exit 1 if any violations found.

set -euo pipefail

DIRS=()
for d in apps packages; do
  [ -d "$d" ] && DIRS+=("$d")
done

if [ ${#DIRS[@]} -eq 0 ]; then
  echo "lint-sql-safety: no apps/ or packages/ directories found"
  exit 0
fi

# Patterns that indicate raw SQL string interpolation (not Drizzle sql tagged template):
#   1. String concatenation with SQL keywords: "SELECT " + var, `INSERT INTO ${`
#   2. Template literals with SQL keywords and ${} interpolation (but NOT tagged with sql`...)
#
# We look for:
#   - SQL keywords followed by ${ inside backtick template literals (untagged)
#   - String concatenation patterns near SQL keywords
#
# Exclude:
#   - Lines with "// SAFE:" annotation
#   - Lines that are Drizzle sql tagged templates (sql`...`)
#   - .test.ts and .spec.ts files in the Bun.spawn pattern (already audited)
#   - Keyword followed by "/" (HTTP-verb route strings like `DELETE /path -> ${status}`,
#     not SQL — SQL DELETE is "DELETE FROM"; see plans/023)

VIOLATIONS=0

# Common grep flags: scan .ts/.tsx/.js, exclude build artifacts
GREP_OPTS=(
  -rn
  --include='*.ts' --include='*.tsx' --include='*.js'
  --exclude-dir='.next' --exclude-dir='dist' --exclude-dir='node_modules'
  --exclude-dir='.turbo' --exclude-dir='coverage'
)

# Pattern 1: Untagged template literals with SQL keywords + interpolation
# Match lines containing SQL keywords inside template literals with ${} that are NOT preceded by sql`
while IFS= read -r line; do
  VIOLATIONS=$((VIOLATIONS + 1))
  echo "VIOLATION: $line"
done < <(
  grep "${GREP_OPTS[@]}" \
    -E '(SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE)\s+(\$\{|[^/[:space:]].*\$\{)' \
    "${DIRS[@]}" 2>/dev/null \
  | grep -v '// SAFE:' \
  | grep -v 'sql`' \
  | grep -v '\.test\.' \
  | grep -v '\.spec\.' \
  || true
)

# Pattern 2: String concatenation with SQL keywords: "SELECT " + variable
while IFS= read -r line; do
  VIOLATIONS=$((VIOLATIONS + 1))
  echo "VIOLATION: $line"
done < <(
  grep "${GREP_OPTS[@]}" \
    -E '"(SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE)\s[^"]*"\s*\+' \
    "${DIRS[@]}" 2>/dev/null \
  | grep -v '// SAFE:' \
  || true
)

# Pattern 3: Variable + SQL keyword string concatenation: variable + "SELECT ..."
while IFS= read -r line; do
  VIOLATIONS=$((VIOLATIONS + 1))
  echo "VIOLATION: $line"
done < <(
  grep "${GREP_OPTS[@]}" \
    -E '\+\s*"(SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE)\s' \
    "${DIRS[@]}" 2>/dev/null \
  | grep -v '// SAFE:' \
  || true
)

if [ "$VIOLATIONS" -gt 0 ]; then
  echo ""
  echo "lint-sql-safety: found $VIOLATIONS violation(s)"
  echo "Fix: use Drizzle query builder operators or annotate with '// SAFE: <reason>'"
  exit 1
fi

echo "lint-sql-safety: OK (no raw SQL interpolation found)"
exit 0
