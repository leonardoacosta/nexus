# Design — Fleet-Aware Rules Evaluation (Phase 1.7)

## Context

Closes the gap activation exposed: rules eval reads the firing agent's local vector, so
headless-agent sessions (the majority) only route correctly by a 2-node happy accident. Additive,
still gated by `presence_aware_routing` (default off). Reference:
`docs/diagrams/presence-routing-research.html` §2-3 (vector + macHost), §5 (data flow).

## Goals / Non-Goals

**Goals**
- Per-machine presence storage (jsonb vector on `fleet_presence`).
- `resolveLiveConsoleVector` + fleet-aware eval in the manager.
- Fix `nx-vbv39` (remote reports persist per-machine rows).

**Non-Goals**
- No new rules (rule set unchanged — only WHICH vector feeds `evaluateRules`).
- No Swift UI batch — the Phase 1.6 `FleetPresenceIndicator` already consumes `/presence/fleet`;
  this only enriches the endpoint payload.
- Multi-user (still single-user, Q6) — phone is global; the resolved-console-machine vector
  carries the phone fields (decision: whole vector from the console machine).

## Key Decisions

### jsonb vector, not typed columns
`fleet_presence` keeps its typed `on_console`/`mac_active`/`mac_locked`/`heartbeat` columns (the
delivery-resolution path + indexes use them) and gains a `vector jsonb` holding the FULL
`PresenceVector`. Rule eval needs all fields (inMeeting, macFocus, phoneHome, isBedtime…);
serializing the whole vector means new presence fields never require a migration. The typed
columns stay as the queryable/indexable fast-path for `resolveLiveConsole` (delivery), the jsonb
is the eval-path source.

### Per-machine vector map in presence-context
`presence-context.ts` moves from a single `userId`-keyed merged vector to a per-machine map
(`machine → PresenceVector`, each field TTL'd). The report's machine identity is its `macHost`
field (the reporting Mac's hostname). On each report + heartbeat tick, the receiving agent
upserts that machine's full vector to `fleet_presence`. This is the change that fixes `nx-vbv39`:
a remote Mac reporting to the headless agent now writes ITS OWN row, so `fleet_presence` reflects
the real fleet instead of only the headless self-row.

### Resolve-then-eval in the manager
`manager.ts` replaces `decidePresenceRoute(flag, localVector)` with: `const v =
resolveLiveConsoleVector(db) ?? localVector; decidePresenceRoute(flag, v)`. The existing
all-unknown guard inside `decidePresenceRoute` covers the null/empty case (fall back to legacy).
`evaluateRules` and the rule set are untouched — only the vector source changes. Single-machine
fleets resolve their own machine as the console (or fall through the guard), so no regression.

### Whole vector from the console machine (decision)
The eval vector is the live-console machine's stored vector in full — mac AND phone/intent fields.
In the single-user fleet the phone co-reports with (or to the same agent as) the console Mac, so
one row carries everything. (A future multi-reporter "phone from freshest across fleet" merge is
out of scope.)

## Data Flow

```text
each Mac sensor -> POST /presence/report (machine = macHost)
  receiving agent: per-machine vector map[machine].merge(report)
                   -> UPSERT fleet_presence[machine] { vector jsonb, on_console, heartbeat }
notification fires on ANY agent:
  v = resolveLiveConsoleVector(SELECT fleet_presence)   // newest on_console, deserialize jsonb
      ?? local vector
  decidePresenceRoute(flag, v) -> evaluateRules(v) -> Action  (all-unknown guard still applies)
```

## Risks / Trade-offs

- **jsonb drift vs the typed columns:** the typed `mac_active`/`mac_locked` and the jsonb vector
  must agree. Write them together in one upsert from the same per-machine vector so they can't
  diverge.
- **Machine identity:** keying on `macHost` (hostname) assumes stable, unique hostnames across the
  fleet — true for the Tailscale fleet. If `macHost` is unknown in a report, fall back to the
  local machine name (don't write an unkeyed row).
- **Stale console rows:** the heartbeat TTL filter in `resolveLiveConsoleVector` excludes a Mac
  that slept without clearing `on_console`; the heartbeat tick keeps live machines fresh.
- **Clock skew:** `heartbeat` is written with the DB `now()` (already the Phase 1.6 convention),
  so newest-heartbeat tie-break stays server-authoritative.
- **No regression invariant:** with `presence_aware_routing` off, or no live console + all-unknown
  local vector, behavior is byte-identical to today (legacy path). Covered by an E2E test.
