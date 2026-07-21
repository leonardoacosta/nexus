# Design — wire-reactive-rate-limit-swap

## Decision 1: One swap primitive, not two

Two swap implementations exist: `pool.manualSwap()` (wired, tested, used by the proactive
evaluator and the promote/manual routes) and `cc-credential-manager.markRateLimitedAndSwap()`
(orphaned, zero callers, round-robin over `cc_profiles`). Running both risks two subsystems
rewriting `~/.claude/.credentials.json` with different selection policies. The reactive flow
reuses `pool.manualSwap()` and the orphan is deleted. The manager keeps its two live jobs —
profile mirroring into `cc_profiles` and proactive OAuth refresh — untouched.

## Decision 2: Detection lives in the dispatcher's notification path

The socket-server dispatcher already sees every CC hook event, including `Notification`
payloads. Detection is a branch there, not a new subscriber, because interception has to
happen *before* fan-out to delivery channels (the spec requires the rate-limit notification
be swallowed when a swap will handle it — delivering "you hit your limit" via TTS while the
agent silently fixes it is noise). Passthrough cases (empty pool, no eligible candidate)
deliver normally so the exhaustion ladder's contract is unchanged.

## Decision 3: File swap, not env pinning (explored and rejected)

`CLAUDE_CODE_OAUTH_TOKEN` overrides the credentials file (verified against CC docs and
issues #16238/#44806). Pinning tokens per session would break the observed and relied-upon
behavior that a single credentials-file change migrates every running session (CC re-reads
the file per request — documented in `cc-credential-manager.ts` and confirmed operationally).
The file is the correct swap surface; the env var is a footgun here.

## Decision 4: Shared flow module owns the side effects

`credential_swaps` rows, swap-tracker stamps, audit entries, and the swap notification were
inconsistently applied (proactive emitted audit only; nothing anywhere wrote
`credential_swaps`). Centralizing them in `performCredentialSwap()` makes "did a swap
happen and why" answerable from one table regardless of trigger, and gives the reactive
and proactive paths identical observability for free. Debounce state also lives here
(in-memory; a restart at worst allows one early re-swap, same tolerance the proactive
evaluator already accepts for its ladder state).

## Decision 5: Squeeze-dry — swap at 98% utilization (operator decision, 2026-07-20)

The trigger is "the moment we notice usage hits 98%": effective remaining
`min(5h remaining, 7d remaining)` ≤ 2%. Rationale: the 5h/7d windows burn on wall-clock
regardless of which account is active, so swapping early (the old ≤10% threshold, or the
briefly-considered 20%) strands headroom that expires unused. Riding each account to 98%
extracts the full window before rotating.

Two supports make the 2% margin safe rather than reckless: the adaptive hot-poll band
(60s ticks from 80% utilization onward) gives ~1-minute notice resolution near the line,
and the reactive interceptor (Decisions 1–2) is the backstop when a parallel burst
overshoots 98 → 100 between ticks — the session gets swapped and auto-continued anyway.
If overshoot turns out to be common in `credential_swaps` data (reactive reasons
dominating), a follow-up can add an ultra-hot poll band (e.g. 15s ≥ 95%) rather than
retreating the threshold.

Candidate eligibility keys to the same line — an account at ≤2% effective remaining is
never a swap target, but anything above it is, consistent with using accounts fully
(swapping from 1% to an 8%-remaining account is correct under this doctrine). Anti-flap
drops 30 → 10 minutes: with per-account `credential_swaps` history now recorded, flapping
is diagnosable rather than something to suppress blindly. Evaluation extends from 5h-only
to both windows, matching the original ask ("5H, 7D usages"): a 7d-exhausted account is
just as unusable as a 5h-exhausted one.
