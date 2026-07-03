# Credential Proactive Swap — rotate before exhaustion, graduated low-headroom alerts

## Context
- touches: `apps/agent/src/services/credential-usage-poller.ts`, `apps/agent/src/services/proactive-swap.ts`, `apps/agent/src/services/proactive-swap.test.ts`, `apps/agent/src/index.ts`

Note: `credential-usage-history` (in flight) also edits `credential-usage-poller.ts` — wave
conflict only, no logical dependency; the conflict matrix serializes them.

## Why

Rotation today is reactive: the `rate-limit-interceptor` swaps only after a 429 / "hit your
limit" event — the session already stalled. The usage poller knows every account's 5h
headroom every 5 minutes, and `pool.manualSwap()` is a working swap primitive, but nothing
connects them. Sessions run a credential into the wall when a fresh one sits idle in the pool.

## What Changes

1. **Proactive swap evaluator** (`apps/agent/src/services/proactive-swap.ts`) — invoked at
   the end of each successful poller tick. When the ACTIVE credential's 5h window has <=10%
   remaining, swap to the eligible candidate with the MOST remaining headroom via
   `pool.manualSwap()`. Candidates with <=10% remaining are ineligible. Skip if a swap
   happened within the last 30 minutes (reuse `swap-tracker.lastSwapAt` — anti-flap).

2. **Graduated exhaustion ladder** — when the active credential is low AND no candidate is
   eligible, emit `NotificationFired` (tts + desktop, same pattern as
   `emitStaleHeartbeatNotification`) as remaining crosses 10%, 8%, 4%, 2%, and 0%. Each
   threshold fires once per 5h window (in-memory dedup keyed by window reset instant). The
   message names the soonest-resetting account and its reset time.

**Decisions taken as defaults (user AFK at refinement — veto at /triage):**
- Trigger/ranking window is the **5h** window only ("current session limit").
- The ladder fires **even when a window resets within 24h** — the "none reset within a day"
  clause is interpreted as message content (soonest reset is named), not as a suppression
  condition, since staying silent while out of runway helps nobody.

## Out of Scope

- Reviving the dead `cc_profiles` / `CcCredentialManager` subsystem.
- Changing the reactive 429 interception path (`rate-limit-interceptor` behavior unchanged).
- Per-session lease-aware swaps (swap targets the host-active credential, as `manualSwap` does).
- Persisting ladder-fired state across agent restarts (worst case: one duplicate notify).
- 7-day-window-based swaps or ranking.
