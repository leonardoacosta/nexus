/**
 * statusline-contract — the wire shape for `~/.claude/scripts/state/usage-cache.json`.
 *
 * Written by `apps/agent/src/services/statusline-usage-file.ts` (the poller's
 * fan-out sink), read by `apps/nexus-statusline` and, externally, cc-tmux's
 * `usage.py` — the on-disk JSON shape must stay byte-identical across all
 * three. `utilization` is a 0–100 percentage.
 *
 * Types only — this package must never gain a runtime dependency or a value
 * export. `nexus-statusline` bundles it into a `bun build --compile` binary,
 * so anything beyond `interface`/`type` here would ship into that binary.
 */

export interface UsagePeriod {
  utilization: number;
  resets_at?: string;
}

export interface UsageResponse {
  five_hour?: UsagePeriod;
  seven_day?: UsagePeriod;
}

export interface CachedUsage {
  fetched_at: number;
  data: UsageResponse;
}
