# iOS Presence Reporter — Phase 2

## Why

Phases 1-1.7 (archived) built presence-aware routing on Mac + agent signals: the rules engine
evaluates against the live-console machine's vector, with `phonePresent`/`phoneHome` derived
agent-side from Tailscale (no iOS needed). But two signals only the **phone** knows are still
missing: whether you're in your **bedtime** window, and whether you've set a **Focus** mode. Today
the bedtime rule (Rule 3) cannot fire and Focus is ignored, so a notification interrupts you at
night or during a Focus the same as any other time.

This phase adds the iOS `PresenceReporter`: the nexus-ios app reports `isBedtime` (from the
HealthKit sleep schedule it already has wired) and `phoneFocusOn` (from `INFocusStatusCenter`) to
the homelab agent's existing `/presence/report`. Bedtime is **configurable** — a setting controls
whether the HealthKit sleep schedule, the OS Sleep Focus, or either/both determine `isBedtime`
(decision: respect both-or-either, toggleable). The Communication Notifications entitlement needed
for `INFocusStatusCenter` is already granted in the Apple Developer portal; this phase adds the
matching key to the local entitlements file.

This enables **Rule 3** (bedtime → silent deliver, gated `is_bedtime AND NOT mac_active` per Q1 so
an active Mac still beats bedtime) and **Focus respect** (a passive interruption level when a phone
Focus is active).

## What Changes

- **iOS `PresenceReporter`** (nexus-ios) — reads the HealthKit sleep schedule (is-now-in-window,
  reusing `HealthKitPushManager`'s `.sleepAnalysis` wiring), the OS Sleep Focus + general Focus
  state (`INFocusStatusCenter`), and POSTs the signals to the homelab agent's `/presence/report`
  over Tailscale. Event-driven (HKObserver wake + Focus-status-change + foreground) — never
  polling, respecting iOS background limits.
- **Communication Notifications entitlement** — add `com.apple.developer.usernotifications.communication`
  to `nexus-ios.entitlements` (portal capability already granted by Leo) so `INFocusStatusCenter`
  authorizes + signs on-device.
- **Configurable bedtime sources** — a `bedtime_sources` setting (`hk | focus | either | both`,
  default `either`). The phone reports the two raw sleep signals (HK-sleep-window,
  Sleep-Focus-active); the AGENT computes `isBedtime` from them per the setting (toggle lives in
  one place, no phone re-sync).
- **Global phone-field overlay** — phone fields (`isBedtime`, `phoneFocusOn`) are GLOBAL (one
  phone), but Phase 1.7 evaluates against the live-console MACHINE's vector. The agent overlays the
  freshest global phone fields onto the resolved eval vector before `evaluateRules`, reconciling
  the Phase 1.7 "phone co-reports with the console Mac" assumption (one phone, N Macs).
- **Rule 3 (bedtime)** — `is_bedtime AND NOT mac_active` → silent deliver (banner, no ding, no
  tts, passive, deliverTo phone), inserted after Rule 2 and before Rule 4. **Focus respect** — when
  `phoneFocusOn`, non-critical delivery drops to `passive` interruption.
- **Mac settings toggle** — a bedtime-sources control in the Mac `Routing` settings pane (HK /
  Focus / either / both).

**Decisions implemented:** bedtime + Focus (entitlement already granted) · bedtime sources
configurable (respect HK and/or Sleep Focus) · Rule 3 ships · phone fields global-overlaid.

## Impact

- Affected capability: `context-aware-routing` (existing — adds the phone surface)
- New iOS reporter process path (event-driven, within existing background-execution limits); reuses
  the existing APNs registration + HealthKit background-delivery infra.
- New `bedtime_sources` setting column on `notification_settings` (migration via `db:generate` →
  commit → deploy `db:migrate`; NEVER `db:push`).
- Behavioral change only when `presence_aware_routing` is ON (still default off): Rule 3 begins
  suppressing notifications during bedtime (unless the Mac is active), and Focus drops delivery to
  passive. No change to the default path.
- iOS-only entitlement/permission additions: Communication Notifications (portal granted) +
  HealthKit (already granted). No Always-location (Q5 — home stays agent-side Tailscale).

## Context
- depends on:
- touches: `packages/db/src/schema/notificationSettings.ts`, `packages/core/src/types/presence.ts`, `apps/agent/src/routes/presence-report.ts`, `apps/agent/src/routes/notification-settings.ts`, `apps/agent/src/notifications/presence-context.ts`, `apps/agent/src/notifications/rules-engine.ts`, `apps/agent/src/notifications/manager.ts`, `apps/agent/src/services/fleet-presence.ts`, `apps/swift/nexus-ios/Sources/App/PresenceReporter.swift`, `apps/swift/nexus-ios/Sources/App/NexusAppDelegate.swift`, `apps/swift/NexusShared/Networking/NexusClient.swift`, `apps/swift/nexus-ios/Resources/nexus-ios.entitlements`, `apps/swift/nexus-mac/Sources/Dashboard/Settings/SettingsRoutingView.swift`, `apps/agent/src/notifications/rules-engine.test.ts`, `apps/agent/src/routes/presence-report.test.ts`, `apps/agent/src/routes/notification-settings.test.ts`, `apps/swift/nexus-ios/Tests/PresenceReporterTests.swift`
