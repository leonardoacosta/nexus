# reaper-prod-parity

## Why

The worktree reaper (`wt reap`) needs cross-platform parity verification on the
production homelab (Linux) and Mac before it can be trusted as the canonical
implementation. Until it proves itself in prod, downstream cleanup — removing
the cross-repo `~/dev/if` reaper artifacts — is blocked, because we cannot
delete the duplicate implementation while its replacement is unverified.

## What Changes

- Verify the reaper behaves identically on homelab Linux and Mac: same
  staleness policy, same PID-liveness reclassification, same `merge_failed`
  preservation.
- Document the parity evidence so the cross-repo cleanup can proceed in a
  follow-up change.

## Context

- touches: `scripts/bin/wt`, `scripts/lib/worktree-helpers.sh`

## Non-Goals

- Removing the cross-repo `~/dev/if` reaper artifacts (deferred to the
  follow-up cleanup once parity is proven).
- Changing the reaper's staleness policy or liveness heuristics.
- Adding new platforms beyond Linux and Mac.
