---
order: 0720d
---

# Proposal: Wire the Reactive Rate-Limit Swap End to End

## Change ID
`wire-reactive-rate-limit-swap`

## Why

The `rate-limit-interceptor` spec describes a reactive flow — detect "hit your limit",
swap the active credential, auto-continue the stalled session — that the TS agent does
not have. Evidence (audited 2026-07-20):

- `markRateLimitedAndSwap()` in `apps/agent/src/cc-credential-manager.ts` has **zero
  non-test callers** — the swap machinery exists but nothing triggers it.
- The phrase `"hit your limit"` has **zero non-test hits** in `apps/agent/src` — the
  detection requirement was never re-wired after the Rust→TS migration.
- `credential_swaps` (`packages/db/src/schema/credentialSwaps.ts`) has **zero non-test
  writers** — the credential-analytics requirement "the interceptor MUST log swap events
  to credential_swaps" is unimplemented, so no swap that ever happened left a trace.
- The only running automation is `proactive-swap.ts` (usage-poller tick): swap at ≤10%
  5h headroom with a 30-minute anti-flap. At a 5-minute poll cadence a heavy burst blows
  through the last 10% before the next tick — which is why the operator ends up doing a
  manual full OAuth in one session to migrate everything.

The mechanism itself is correct and confirmed in the field: Claude Code re-reads
`~/.claude/.credentials.json` on each request (documented in `cc-credential-manager.ts`),
so a single file swap migrates every running session on the machine with no restart.
Per-session `CLAUDE_CODE_OAUTH_TOKEN` pinning was explored and rejected — the env var
overrides the credentials file and would break exactly this all-sessions-follow behavior.

## What Changes

- **Detection**: the socket-server dispatcher's notification path matches rate-limit
  events (case-insensitive phrase set: "hit your limit", "usage limit reached"; plus
  `rate_limit_event` payloads with utilization ≥ 1.0). With an eligible swap candidate,
  the notification is intercepted (not delivered to TTS/desktop) and the reactive flow
  runs; with none, it passes through and the exhaustion-handler ladder applies as today.
- **One swap primitive**: a shared `credential-swap-flow` module wraps
  `pool.manualSwap()` + swap-tracker `recordSwap()` + a `credential_swaps` row insert +
  audit entry + a `NotificationFired` ("swapped <from> → <to>") on tts+desktop. Both the
  new reactive path and the existing proactive evaluator go through it. The orphaned
  `markRateLimitedAndSwap()` duplicate is removed.
- **Auto-continue**: after a reactive swap, "continue" is sent to the triggering
  session's tmux target via the existing send-keys helper (`commands-send-text.ts`);
  missing target logs a WARN and the swap stands.
- **Debounce**: 180s in-memory window — sessions rate-limiting inside it get
  auto-continue only, no re-swap.
- **Proactive trigger at 98% utilization (squeeze-dry)**: the evaluator swaps the moment
  any window of the active credential reaches 98% utilization — effective remaining
  `min(5h remaining, 7d remaining)` ≤ 2%. Swapping earlier strands headroom the window
  burns on wall-clock anyway; riding to 98% uses each account fully. The 60s hot-poll
  band (engages at 80% utilization) gives ~1-minute notice resolution near the line, and
  the reactive path above is the backstop for a burst that overshoots 98 → 100 between
  ticks. Candidate eligibility keys to the same line (ineligible at ≤2% effective
  remaining); anti-flap 30 → 10 minutes.

## Context

- depends on: (none)
- touches: `apps/agent/src/services/credential-swap-flow.ts`, `apps/agent/src/services/credential-swap-flow.test.ts`, `apps/agent/src/services/socket-server/dispatcher.ts`, `apps/agent/src/services/socket-server/dispatcher.test.ts`, `apps/agent/src/services/proactive-swap.ts`, `apps/agent/src/services/proactive-swap.test.ts`, `apps/agent/src/routes/commands-send-text.ts`, `apps/agent/src/cc-credential-manager.ts`, `apps/agent/src/cc-credential-manager.test.ts`, `apps/agent/src/index.ts`, `apps/agent/src/services/reactive-swap.integration.test.ts`

- Delta also modifies `exhaustion-handler` (ladder-suppression scenario asserted an
  auto-swap at 9% remaining, which contradicts the 98% trigger; candidate-eligibility
  wording re-keyed to the 2% line).

- Extends: `apps/agent/src/services/proactive-swap.ts` (refactored onto the shared flow;
  threshold/anti-flap constants tuned)
- Extends: `apps/agent/src/services/socket-server/dispatcher.ts` (detection branch in the
  existing notification path)
- Implements (no delta needed): the existing `credential-analytics` requirement that swap
  events persist to `credential_swaps` — spec'd, never wired.
- Related: archive `2026-07-17-adaptive-usage-poll-cadence` (hot 60s poll band the tuned
  proactive threshold relies on); `credential-pool` fingerprint/mirroring (unchanged).

## Testing

- Detection seam (dispatcher): unit matrix in task 4.1 — phrase hit, utilization ≥ 1.0,
  passthrough on empty pool, passthrough when no eligible candidate.
- Swap flow seam: unit tests in task 4.1 — `credential_swaps` row written, swap-tracker
  stamped, notification emitted, debounce honored.
- Auto-continue seam: unit test in task 4.1 — send-keys invoked with the session's tmux
  target; missing-target WARN path.
- End-to-end: integration test in task 4.2 — socket notification through dispatcher →
  swap → row → mocked tmux send-keys → debounced second session.
- Proactive tuning: existing `proactive-swap.test.ts` scenarios updated in task 2.6.

## Done Means

- A session that hits its usage limit resumes on the best available account within
  seconds, with no manual re-OAuth — and every other session on the machine follows via
  the shared credentials file.
- Operator can see every swap after the fact: a `credential_swaps` row plus a
  "swapped <from> → <to>" notification for both reactive and proactive swaps.
- Each account is used to 98% of its 5h/7d windows before the proactive swap moves on —
  no stranded headroom — and under normal load the reactive path is the fallback, not
  the norm.
- The manual re-OAuth workflow keeps working exactly as today (watcher mirrors the new
  account into the pool; nothing pins sessions to an account).
