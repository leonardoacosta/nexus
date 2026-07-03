# Tasks — credential-proactive-swap
<!-- beads:epic:nx-1o6sd -->
<!-- beads:feature:nx-3znig -->

## API Batch
- [ ] [1.1] Create `apps/agent/src/services/proactive-swap.ts` — `evaluateProactiveSwap({ db, pool, swapTracker })`: read fresh 5h usage for all primary+available rows, resolve the ACTIVE row via `getActiveCredentialSnapshot().fingerprint`, compute remaining ratio `(limit - used) / limit`. Return early when active remaining > 0.10 or `limit == 0`/no data. [owner:api-engineer] [beads:nx-74hmh]
- [ ] [1.2] Swap branch: rank candidates by 5h remaining desc, drop those with remaining <= 0.10, skip entirely if `swapTracker.lastSwapAt` is within 30 min; call `pool.manualSwap(target.id)`, falling through to the next candidate on the "target credential is in cooldown" error; emit `credential.auto_swap_out`/`credential.auto_swap_in` audit entries (actor `auto-usage`, reuse `emitAudit` pattern from `handlers-swap.ts`). [owner:api-engineer] [beads:nx-ozc4z]
- [ ] [1.3] Ladder branch: when no eligible candidate, fire `NotificationFired` on `tts` + `desktop` via `lifecycleBus` (same shape as `emitStaleHeartbeatNotification` in `reaper-job.ts:502`) for each threshold in {10, 8, 4, 2, 0}% newly crossed; dedup via in-memory `Map<fingerprint, Set<threshold>>` keyed by the 5h window's `resetAt` (clear entries when `resetAt` changes); message names the soonest-resetting account + reset time. [owner:api-engineer] [beads:nx-ffn8z]
- [ ] [1.4] Invoke `evaluateProactiveSwap` at the end of a successful tick in `apps/agent/src/services/credential-usage-poller.ts` (injected via `StartCredentialUsagePollerOpts` so tests can stub it); failures logged, never thrown into the tick. [owner:api-engineer] [beads:nx-oekhj]
- [ ] [1.5] Wire the evaluator into poller startup in `apps/agent/src/index.ts`, passing the pool + swap-tracker already constructed there. [owner:api-engineer] [beads:nx-s5lc5]

## E2E Batch
- [ ] [2.1] Create `apps/agent/src/services/proactive-swap.test.ts`: healthy active -> no swap; low active + two candidates -> manualSwap called with max-headroom id; all candidates <=10% -> no swap; recent swap (lastSwapAt 10 min ago) -> no swap; cooldown error on first target -> falls through to second. [owner:e2e-engineer] [beads:nx-3hz87]
- [ ] [2.2] Ladder tests: crossing 11%->9% fires 10% and 8% once (tts + desktop payloads asserted, soonest-reset named); steady 9% fires nothing further; new `resetAt` re-arms the ladder; eligible candidate present -> ladder suppressed; 0% fires the final threshold. [owner:e2e-engineer] [beads:nx-ixqhf]
- [ ] [2.3] Poller integration test in `credential-usage-poller.test.ts`: a successful `tickOnce()` invokes the injected evaluator; an evaluator throw is logged and does not fail the tick. [owner:e2e-engineer] [beads:nx-a58c7]
