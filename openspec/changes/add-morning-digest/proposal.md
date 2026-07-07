# Add Morning Digest

## Why

Per-item notifications are the interrupt problem, not its solution — the
2026-07-07 scheduling diagnosis: unbounded interrupts with no admission
control. The digest replaces "N pings a day" with exactly one: a morning
push composing the queue head (what to do first) and the fleet exceptions
summary (what's rotting), sent through the notify transport nx already
operates. It is the phone-side analog of the session-primer lines: guidance
delivered where Leo already looks, once, at a predictable time.

## What Changes

- Agent-side scheduled job (daily at `DIGEST_HOUR`, default 07:30 local,
  env-configurable; skipped cleanly if already sent that day — idempotent
  across agent restarts via a sent-marker file).
- Digest composition: queue-head line ("first: <action> — <title>") + up to 5
  exception lines from `GET /exceptions` (shape-not-items, same caps) + a
  session pointer ("N verdicts waiting — open the menubar deck"; N is the
  session size 10 max, NOT the backlog total).
- Degrades: exceptions feed unavailable -> queue-head-only digest; queue
  empty AND no exceptions -> digest says "clear" (still sent — the absence
  of a ping must be meaningful only for delivery failure, never ambiguity).
- Delivery through the existing notify dispatch path (the transport
  nexus-agent already serves for mx notify: telegram/banner — searched:
  mx internal/cred/notify.go -> nexus-agent :7400 per the mx radar
  investigation; reuse, no new transport).
- Explicit invariant: this change adds ZERO per-item notification paths, and
  the digest never includes override rates or backlog totals.

## Non-Goals

- No native APNs push (telegram/banner transports suffice for the pilot).
- No evening/second digest, no configurable multi-schedule.
- No per-item or realtime notifications of any kind.

## Impact

- Affected specs: new capability `daily-digest`.
- Affected code: `apps/agent/src/` (scheduler + composer + sent-marker).
- Depends on: add-fleet-exceptions-feed (degrades gracefully without it).

## Testing

- Composer unit tests: full digest, queue-head-only degrade, clear digest,
  exception line cap, no-backlog-total invariant (assert the composed string
  never contains the open-count).
- Scheduler: sent-marker idempotency (double-fire same day = one send),
  restart mid-day does not resend.
- Runtime evidence: one real digest delivered; paste the received message.
