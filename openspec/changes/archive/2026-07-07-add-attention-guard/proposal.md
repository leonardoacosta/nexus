# Add Attention Guard (Statusline Drift Line + Session Clock)

## Why

Hyperfocus drift is measured, not hypothetical: cc meta-work consumed 33.8%
of all sessions over 30 days while a P1 security fix idled 7 weeks. And time
blindness makes session length invisible from inside the session. Both fixes
are pure rendering — passive statusline additions in the surface Leo already
reads every prompt (nexus-statusline), zero interrupts, silent when healthy.
Nag mechanisms were considered and rejected (they punish productive
hyperfocus and erode surface trust); a clock and an exception line are not
nags.

## What Changes

- nexus-statusline drift line: reads the agent's `GET /queue?limit=1`
  (SWR-cached, same fail-soft conventions); renders ONE line only when the
  queue head is a preempt-action or high-confidence verdict AND its request
  does not belong to the current session's project context. Silent
  otherwise, silent on fetch failure.
- Session clock: elapsed session time rendered passively in the statusline
  (from session start), plain text, no thresholds, no colors escalating, no
  nag — time made visible, nothing more.

## Non-Goals

- No notifications, no blocking, no auto-actions, no thresholds that change
  behavior — both additions are display-only.
- No backlog counts or rates (standing invariant).

## Impact

- Affected specs: new capability `attention-guard`.
- Affected code: `apps/nexus-statusline/src/` (two render additions + one
  cached fetch following the getRoadmapPulse() shape).

## Testing

- Unit: drift line renders on preempt-head + foreign-project fixture; silent
  on same-project head, low-confidence head, empty queue, fetch failure.
  Clock formats correctly across hour boundaries.
- Runtime evidence: statusline screenshot/paste in a cc session with a
  planted foreign preempt head, and one healthy session showing silence.
