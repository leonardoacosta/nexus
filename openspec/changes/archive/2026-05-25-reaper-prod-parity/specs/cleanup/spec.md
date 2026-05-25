# cleanup

## ADDED Requirements

### Requirement: Cross-Platform Reaper Parity Verification

The reaper (`wt reap`) MUST exhibit identical behaviour on the production
homelab (Linux) and Mac — the same staleness policy, the same PID-liveness
reclassification, and the same `merge_failed` preservation — and the parity
evidence MUST be captured so the downstream cross-repo cleanup can proceed.

#### Scenario: Stale worktree reaped identically on both platforms

- **WHEN** `wt reap` runs against a worktree older than the staleness threshold
  on both homelab Linux and Mac
- **THEN** both hosts reclassify and reap the worktree using the same staleness
  policy, and the captured evidence shows matching outcomes

#### Scenario: Live PID and merge_failed preserved on both platforms

- **WHEN** `wt reap` encounters a worktree with a live owning PID or a
  `merge_failed` marker on both homelab Linux and Mac
- **THEN** both hosts preserve the worktree via PID-liveness reclassification
  and `merge_failed` preservation, with the evidence documenting parity
