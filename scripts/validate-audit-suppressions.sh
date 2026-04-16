#!/usr/bin/env bash
# validate-audit-suppressions.sh — CI lint for .audit-suppressions.json
#
# Ensures every suppression entry has a non-empty reason field so the file
# cannot silently become a dumping ground for unexplained skips.
#
# Exit codes:
#   0 — file absent (allowed) or all entries valid
#   1 — one or more entries missing/invalid id, paths, or reason
#   2 — file exists but is not valid JSON
#
# Dependencies: jq (standard on CI runners).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUPPRESSIONS_FILE="$REPO_ROOT/.audit-suppressions.json"

if [[ ! -f "$SUPPRESSIONS_FILE" ]]; then
  echo "validate-audit-suppressions: $SUPPRESSIONS_FILE not present — skipping (ok)"
  exit 0
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "validate-audit-suppressions: jq not installed — cannot validate" >&2
  exit 2
fi

if ! jq -e '.' "$SUPPRESSIONS_FILE" >/dev/null 2>&1; then
  echo "validate-audit-suppressions: $SUPPRESSIONS_FILE is not valid JSON" >&2
  exit 2
fi

# Emit one diagnostic line per invalid entry. Each line is:
#   <index>\t<field>\t<message>
# Exit code is determined by whether any line was emitted.
INVALID=$(
  jq -r '
    .suppressions // [] | to_entries | .[] |
    . as $entry |
    ($entry.value.id // null) as $id |
    ($entry.value.paths // null) as $paths |
    ($entry.value.reason // null) as $reason |
    (
      if ($id | type) != "string" or ($id | length) == 0 then
        [$entry.key, "id", "missing or not a non-empty string"] | @tsv
      else empty end
    ),
    (
      if ($paths | type) != "array" or ($paths | length) == 0 then
        [$entry.key, "paths", "missing or not a non-empty array"] | @tsv
      elif ([$paths[] | select(type != "string" or length == 0)] | length) > 0 then
        [$entry.key, "paths", "contains non-string or empty path"] | @tsv
      else empty end
    ),
    (
      if ($reason | type) != "string" then
        [$entry.key, "reason", "missing or not a string"] | @tsv
      elif (($reason | gsub("\\s"; "")) | length) == 0 then
        [$entry.key, "reason", "empty or whitespace-only"] | @tsv
      else empty end
    )
  ' "$SUPPRESSIONS_FILE"
)

if [[ -n "$INVALID" ]]; then
  echo "validate-audit-suppressions: invalid entries in $SUPPRESSIONS_FILE:" >&2
  while IFS=$'\t' read -r idx field msg; do
    [[ -z "$idx" ]] && continue
    echo "  - suppressions[$idx].$field: $msg" >&2
  done <<< "$INVALID"
  echo "" >&2
  echo "Every suppression entry must have:" >&2
  echo "  - id:     non-empty string (e.g. \"D4\")" >&2
  echo "  - paths:  non-empty array of non-empty strings" >&2
  echo "  - reason: non-empty, non-whitespace string explaining why the suppression is justified" >&2
  exit 1
fi

COUNT=$(jq -r '.suppressions // [] | length' "$SUPPRESSIONS_FILE")
echo "validate-audit-suppressions: OK ($COUNT entr$([ "$COUNT" = "1" ] && echo "y" || echo "ies") validated)"
exit 0
