# Design — iOS Presence Reporter (Phase 2)

## Context

Adds the phone surface to presence routing. Additive, still gated by `presence_aware_routing`
(default off). Reference: `docs/diagrams/presence-routing-research.html` §1 (iOS signals), §3
(Rule 3), and the locked Q5 (geofencing deferred — home stays agent-side Tailscale).

## Goals / Non-Goals

**Goals**
- iOS reports bedtime (HK sleep schedule) + Focus (`INFocusStatusCenter`) to the agent.
- Configurable bedtime sources (HK / Focus / either / both), agent-computed.
- Rule 3 (bedtime) + Focus-respect (passive when a Focus is on).
- Reconcile the Phase 1.7 phone-fields gap (global overlay).

**Non-Goals**
- No Always-location / geofencing (Q5 — `phoneHome`/`phonePresent` stay agent-side Tailscale).
- No watch delivery / escalation (Phase 3). No silent-push context-query (the reporter is
  push-on-change; a server-driven query is a later optimization).
- No new rules beyond Rule 3 (Rules 5-8 later).

## Key Decisions

### Reuse the existing HealthKit + APNs infra
`HealthKitPushManager` already registers `.sleepAnalysis` background delivery and the HealthKit
entitlements are granted. The reporter reads the sleep SCHEDULE (forward-looking "in-window now")
rather than the lagged sleep SAMPLE, and reuses the existing HKObserver wake to emit. `ApnsRegistrar`
+ the device-token store already exist; no new push registration.

### Phone reports raw signals; agent applies the bedtime policy
The phone sends two booleans — HK-sleep-window and Sleep-Focus-active — plus `phoneFocusOn`. The
agent's `bedtime_sources` setting (`hk|focus|either|both`, default `either`) computes `isBedtime`.
Keeping the policy agent-side means the toggle is one place (the Mac settings pane) and never needs
a phone re-sync. `bedtime_sources` is a new `notification_settings` column.

### Global phone-field overlay (reconciles Phase 1.7)
Phase 1.7 evaluates against the live-console machine's vector and assumed "phone co-reports with the
console Mac." In reality the phone reports to the homelab agent independently, and its fields are
global (one phone). So the agent holds phone presence as a global record and OVERLAYS the freshest
`isBedtime`/`phoneFocusOn` onto the resolved eval vector (after `resolveLiveConsoleVector`, before
`evaluateRules`). This is the correct "Mac-from-console + phone-global" model for 1 phone + N Macs.
A phone field past its TTL reads `unknown` and does not override.

### Rule 3 + Focus respect
Rule 3 (`is_bedtime AND NOT mac_active` → silent passive banner to phone) inserts between Rule 2 and
Rule 4 — active Mac (Rule 1) still beats bedtime (Q1). Focus-respect is a MODIFIER, not a rule: when
`phoneFocusOn`, a non-critical matched action's `interruptionLevel` drops to `passive` (the rule's
channels are unchanged). Critical is unaffected (Rule 0 deferred anyway).

### iOS background reality
The reporter is event-driven: HKObserver wake (sleep schedule), `INFocusStatusCenter` change
observer (Focus), and foreground. No timer/poll. Between wakes the agent's phone fields age out to
`unknown` (TTL ~ a few minutes longer than the Mac TTL, since phone wakes are sparser). This matches
the §1 iOS constraint — a backgrounded app cannot freely report.

## Data Model

```text
notification_settings (MODIFY) + bedtime_sources text $type<"hk"|"focus"|"either"|"both"> = "either"
PresenceVector (core)          + phoneFocusOn PresenceField<boolean>   (isBedtime already exists)
/presence/report body           + hkSleepWindow, sleepFocusActive, phoneFocusOn  (phone machine key)
```
Migration: `db:generate` → commit the `.sql` → deploy `db:migrate`. NEVER `db:push`.

## Data Flow

```text
nexus-ios PresenceReporter (HKObserver / Focus-change / foreground)
  -> POST homelab:7400/presence/report { machine:"<phone>", hkSleepWindow, sleepFocusActive, phoneFocusOn }
agent: global phone record .merge(report); isBedtime = applyBedtimeSources(setting, signals)
notification fires:
  v = resolveLiveConsoleVector() ?? local; v = overlayGlobalPhoneFields(v)   // isBedtime, phoneFocusOn
  evaluateRules(v) -> Rule 3 (bedtime) / Focus-respect passive modifier
```

## Risks / Trade-offs

- **Focus signal availability:** `INFocusStatusCenter` reports a boolean and only if the user shares
  a Focus; often `unauthorized`. `phoneFocusOn` is therefore best-effort — when `unknown`, no Focus
  respect applies (fail-open to normal delivery). Don't gate bedtime on Focus unless `bedtime_sources`
  explicitly selects `focus`.
- **HK sleep schedule access:** reuses granted HealthKit; if the schedule isn't set, the HK source
  yields no bedtime (the `either`/`focus` policies still work via Sleep Focus).
- **Shared Swift files:** `NexusAppDelegate.swift` + `NexusClient.swift` are also touched by the
  active `ios-session-navigation` change — declared in `- touches:` so wave-plan serializes them.
- **Phone TTL staleness:** sparse iOS wakes mean `isBedtime`/`phoneFocusOn` can be `unknown` between
  reports; the overlay treats `unknown` as no-override (fail-safe — bedtime won't wrongly suppress).
- **On-device verification gate:** the iOS build/sign needs the Mac awake + a connected device
  (`devicectl`); the agent batches (DB/API/E2E) are independently `bun test`-verifiable.
- **No-regression:** flag-off + no phone report → behavior identical to Phase 1.7 (overlay is a no-op
  when phone fields are `unknown`). Covered by an E2E test.
