# Add Decide Flow (macOS Menubar Pilot)

## Why

mx now persists an LLM triage verdict per open request (add-triage-verdict-layer,
mx-3z8y) and records human accept/override decisions — but its pilot gate needs
>= 30 decisions before any further surface investment, and decisions can only
accumulate if there is a surface to make them on. Nothing renders verdicts or
posts decisions today: the web /radar page is deliberately a source-health
mirror, and the Swift TriageObserver reads the triage feed without the verdict
fields.

Design intent (locked 2026-07-07 session): the surface is a gate, not a mirror —
session-boxed serial triage, server-only ranking, five narrow actions, no
sidetrack affordances. Pilot platform is the macOS menubar popover (where
context switches actually happen); iOS reuses the shared views after the gate.

## What Changes

- nexus-agent: two new mx-gateway passthroughs following the existing
  /requests conventions — `GET /queue` (ranked batch; fail-soft empty-200) and
  `POST /requests/{id}/decision` (write-back; NOT fail-soft — gateway errors
  and 409s propagate verbatim, a swallowed decision is silent data loss).
- NexusShared: `TriageItem` gains optional verdict fields (additive Codable —
  old payloads still decode); new `DecideSession` observable (batch fetch,
  index, skip counts, paused state) and a decision-posting endpoint on the
  existing NexusClient pattern.
- nexus-mac: `MenuBarExtra` decide surface — level 1: the single queue-head
  action rendered compactly; level 2 (popover): the session deck. One card at
  a time, 10 per session, keyboard equivalents A/O/P/S/G, constrained override
  (six actions + optional note), inline thread peek, skip friction (3rd skip
  forces decide-or-snooze), full-stop session end with no continue affordance.
- Anti-bias/anti-sidetrack invariants carried into UI: no backlog counts inside
  the flow, no override-rate or streak anywhere, no sort/filter controls, no
  per-item notifications.

## Non-Goals

- iOS and watchOS surfaces (post-gate; views land in NexusShared so the port is
  cheap, but no iOS wiring ships here).
- apps/web changes — /radar stays a mirror, gaining only a passive mention of
  the menubar flow at most nothing.
- Slot caps / expiry mechanics (post-gate spec, per add-triage-verdict-layer).
- Any change to verdict generation, ranking, or report (mx-owned).

## Impact

- Affected specs: new capability `decide-flow`. `radar-panel` untouched.
- Affected code: `apps/agent/src/routes/` (+2 routes), `NexusShared/Models/`
  (TriageItem extension), `NexusShared/Observers/` or `Networking/`
  (DecideSession + client endpoint), `apps/swift/nexus-mac` (menubar views),
  `project.yml` only if a new target/group is required (expect none).
- Depends on mx `add-queue-batch` (GET /queue endpoint) landing first; until
  then the deck falls back to a single-item session via /queue/head.

## Testing

- Agent routes: vitest alongside requests.test.ts — param forwarding, fail-soft
  on GET /queue, verbatim 409/5xx propagation on POST decision.
- NexusShared: decode tests for verdict-present and verdict-absent payloads;
  DecideSession state math (advance, skip counts, forced-decision at 3, session
  end) as pure unit tests.
- Swift typecheck via the Linux->Mac headless contract (ssh mac + xcodegen +
  swiftc -typecheck) per swift-engineer conventions.
- [user] on-device verification: run the menubar app, complete one real session
  including one accept, one override-with-note, one peek, one skip; paste the
  resulting mx_verdict_decisions rows as runtime evidence.
