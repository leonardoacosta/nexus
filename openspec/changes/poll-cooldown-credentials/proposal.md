---
order: 0719b
---

# Proposal: Poll cooldown credentials so 5H/7D usage does not freeze during session-limit cooldown

## Change ID
`poll-cooldown-credentials`

## Summary
`queryPollableRows` (`apps/agent/src/services/credential-usage-poller.ts`) selects only
`isPrimary = true AND status = 'available'`. When a credential hits its 5-hour session limit,
the auto-swap moves it to `status = 'cooldown'` — and from that moment it leaves the poll set
entirely. Its `usage5hUsed`/`usage7dUsed` columns freeze at the last pre-cooldown poll, so every
downstream surface (cc-tmux row 2, accounts popup, dashboard) renders a stale number exactly
during the window the operator is watching it most. The hot-interval requirement (60s tick at
>= 80% 5H utilization) is also defeated: the >= 80% credential is no longer polled, so the
poller reverts to the 5-minute default cadence.

Runtime evidence (2026-07-19, homelab): active credential `leo@leonardoacosta.dev·37a74420`
in `status: 'cooldown'` with `usagePolledAt` 43 minutes stale at a rendered 5H:94%; journalctl
shows `attempted` dropping 4 -> 3 at the 02:07:42Z auto-swap and tick spacing reverting from
60s (hot) to 5 minutes immediately after.

This proposal widens the poll set to include `status = 'cooldown'` rows. It deliberately does
NOT include `refresh_failed` rows (dead OAuth attempts, ~20 on the live payload) — polling
those would fail every tick, trip the >50%-failure backoff, and slow polling for everyone.

## Context
- Extends: `apps/agent/src/services/credential-usage-poller.ts` (`queryPollableRows`)
- Related: installfest proposal `cc-tmux-usage-reset-countdown` (companion display-side change
  in `~/dev/personal/installfest` — renders `usage5hResetAt` as a countdown; cross-repo, not
  expressible via this repo's `- depends on:`)
- depends on: (none — no in-flight nexus proposal touches the usage poller)
- touches: `apps/agent/src/services/credential-usage-poller.ts`, `apps/agent/src/services/credential-usage-poller.test.ts`

> **Two parser-visible contracts.** `/triage` reads `- depends on:`; `wave-plan-build` reads
> `- touches:`.

## Motivation
During a session-limit cooldown the statusline is the operator's only at-a-glance answer to
"can I resume yet / how close is the reset" — and that is precisely when the number stops
updating. The hot-interval machinery built for this exact moment (>= 80% 5H) never engages
because the status filter starves it of the one credential in the hot band.

## Non-Goals
- Polling `refresh_failed` rows (would poison the failure-rate backoff signal).
- Auto-restoring `cooldown` -> `available` when the 5-hour window resets (credential-pool /
  proactive-swap ownership, separate concern).
- Any display-side change (companion installfest proposal owns cc-tmux rendering).

## Done Means
- During a session-limit cooldown, the active credential's 5H/7D percentages in cc-tmux row 2
  keep updating (usagePolledAt stays within ~2 minutes while the credential is >= 80% 5H).
- The hot interval (60s tick) engages while a cooldown credential is at/above 80% 5H
  utilization.
- `refresh_failed` rows remain excluded from the poll set (no backoff regression).

## Testing
- Unit: `credential-usage-poller` test asserting `queryPollableRows` returns rows with
  `status = 'cooldown'` and still excludes `refresh_failed` (tasks 1.1).
- Runtime: live `journalctl` tick evidence + `/credentials` `usagePolledAt` recency for a
  cooldown credential on the deployed agent (tasks 2.1).
