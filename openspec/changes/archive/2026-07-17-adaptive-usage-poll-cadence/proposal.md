---
order: 0717a
---

# Proposal: Adaptive Usage-Poll Cadence Near Session Limit

## Change ID
`adaptive-usage-poll-cadence`

## Summary
Tighten `credential-usage-poller`'s tick interval from 5 minutes to 60 seconds whenever any
active credential's 5-hour utilization crosses 80%, so downstream consumers (cc-tmux row2,
statusline, dashboards) stop lagging Claude Code's own live session-limit banner by up to a
full poll window exactly when the number matters most.

## Context
- touches: `apps/agent/src/services/credential-usage-poller.ts`, `apps/agent/src/services/credential-usage-poller.test.ts`
- Extends: the poller shipped under `credential-analytics`; the session-scoped read side
  already exists (`GET /statusline?sessionId=` → session credential's `fiveHour`/`sevenDay`,
  shipped by `redesign-status-usage-endpoints`, archived 2026-07-14).
- Cross-repo follow-up (NOT in this spec's tasks — different repo): cc-tmux
  (`~/dev/personal/installfest/apps/cc-tmux`) still renders the globally-freshest
  `isActive:true` credential from `GET /credentials` (`usage.py _freshest_active()`), not the
  running session's credential. It should consume `GET /statusline?sessionId=` instead.
  Tracked as a `[TARGET]` bead under this proposal's feature bead.

## Motivation
Observed 2026-07-17: Claude Code's banner reported "99% of session limit" while the tmux row
showed `5H:79%`. Root cause is cadence, compounded by account scoping:

1. The poller ticks every 5 minutes (`DEFAULT_INTERVAL_MS`, 30-minute backoff on failure
   bursts), and cc-tmux adds a 45s disk cache — so during a heavy `/apply` burn the rendered
   percentage can trail reality by 20+ points right as the limit is about to bite.
2. cc-tmux row2 is not session-scoped (cross-repo follow-up above).

A fixed 60s interval for all time would 5x the call volume against
`api.anthropic.com/api/oauth/usage` for no benefit at low utilization. Adaptive cadence spends
the extra polls only inside the danger band.

## Proposed Change
In `credential-usage-poller.ts`:

- Extract the next-tick delay decision into a pure, exported
  `computeNextIntervalMs({ maxFiveHourUtilization, backoff, intervalMs, hotIntervalMs })`.
- After each tick, compute `maxFiveHourUtilization` = max `usage5hUsed/usage5hLimit`-derived
  utilization (the poller already holds the freshly parsed `utilization` values) across the
  credentials just polled.
- Selection order: failure backoff (30 min) wins as today > hot interval (60s,
  `NEXUS_USAGE_POLL_HOT_INTERVAL_MS` override) when `maxFiveHourUtilization >= 80` > default
  (5 min, existing `NEXUS_USAGE_POLL_INTERVAL_MS` override).
- Threshold constant `HOT_THRESHOLD_PCT = 80`, not env-configurable (YAGNI; revisit on demand).

No schema, route, or wire-format changes. No new endpoints — the session-scoped read side is
already live.

## Non-Goals
- cc-tmux consumption change (cross-repo, installfest — tracked bead, not this spec).
- Per-credential staggered polling (all credentials still poll on one shared tick).
- Any change to the 45s cc-tmux disk cache.

## Testing
- Unit (`credential-usage-poller.test.ts`): `computeNextIntervalMs` selection table — backoff
  wins over hot; hot at exactly 80 and above; default below 80; env override respected for hot
  interval; null/zero-limit utilizations excluded from the max.
- Integration: existing poller tick tests extended to assert the rescheduled delay after a
  tick whose parsed utilization is >= 80 is the hot interval.
- E2E: N/A — no user-facing flow in this repo changes; the consumer-visible effect lands with
  the cross-repo cc-tmux bead.
