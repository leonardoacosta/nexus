---
stack: t3
---
<!-- beads:epic:nx-qayeb -->
<!-- beads:feature:nx-maq3x -->

# Implementation Tasks

## API Batch

- [ ] [1.1] In `apps/agent/src/services/credential-usage-poller.ts`, widen `queryPollableRows` from `eq(credentials.status, "available")` to `inArray(credentials.status, ["available", "cooldown"])` (keep `isPrimary = true`). Update the file's header comment (line ~8, "Query rows where is_primary = true AND status = 'available'") to match. Add/extend unit tests in `apps/agent/src/services/credential-usage-poller.test.ts` asserting: (a) a `status: 'cooldown'` primary row IS returned by `queryPollableRows`, (b) a `status: 'refresh_failed'` row is NOT returned, (c) `computeNextIntervalMs` still selects the hot interval when the cooldown credential's 5H utilization is >= 80. Run the poller test file and paste PASS output. [beads:nx-yu1eh]
- [ ] [1.2] Runtime-verify against the live dev agent: with the active credential in `status: 'cooldown'` (or a seeded cooldown row), confirm the next poller tick includes it — `journalctl --user -u nexus-agent | grep credential-usage-poller` shows `attempted` incremented and, when its 5H >= 80%, subsequent ticks arrive at ~60s spacing; `curl -s localhost:7400/credentials` shows the cooldown row's `usagePolledAt` within the last 2 minutes. Paste both outputs. [beads:nx-eas17]
  - depends on: 1.1

## E2E Batch

- [ ] [2.1] Targeted `git add apps/agent/src/services/credential-usage-poller.ts apps/agent/src/services/credential-usage-poller.test.ts` (no `git add -A`/`.`); commit `fix(usage-poller): poll cooldown credentials so 5H/7D does not freeze at session limit`; push through the normal deploy hook and confirm `systemctl --user status nexus-agent` picks up the new build. Paste live post-deploy evidence: a cooldown credential's `usagePolledAt` refreshing on the deployed instance. [beads:nx-v8cgf]
  - depends on: 1.1, 1.2
