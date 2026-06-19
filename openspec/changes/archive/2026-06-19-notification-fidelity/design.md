## Context
Two notification defects bundled because both are small "notifications should do what they say"
fixes that touch disjoint files (agent TS vs Swift NexusShared/mac/ios) and cannot conflict. The
title fix became cross-cutting once parity was requested across three surfaces (iOS APNS push,
macOS banner, iOS in-app list), which spans the agent/Swift boundary — hence this design note.

Source of truth for the findings: the 2026-06-18 Serval QoL exploration (memory
`project-serval-qol`). No `packages/core` schema change is required — `project`, `sessionName`,
and `sessionId` already flow end-to-end on `NotificationFiredPayload` and the Swift
`NotificationEvent`.

## Goals / Non-Goals
- Goals:
  - The banner toggle suppresses banners when off (default on).
  - macOS notification grant state is visible in the launch trace.
  - Titles read `project · session` on all three surfaces, identically.
- Non-Goals:
  - Auto-remediating a denied OS grant (impossible post-denial; System Settings only).
  - An in-app "open System Settings" affordance (deferred — log-only this change).
  - Any change to notification persistence, channels, or the delivery pipeline.

## Decisions

- **Decision: the title rule is duplicated across the TS/Swift boundary, not centralized.**
  The APNS push title is built server-side by the agent (`notification-push.ts`); the macOS
  banner and iOS in-app titles are built client-side in Swift from the `NotificationEvent`. There
  is no shared runtime between them, so the rule is written twice — once in TS, once in Swift —
  with a spec requirement that both produce identical output. This is accepted duplication, not
  drift: the format is a single literal (`<a> · <b>`) and both sites are covered by the
  notification-store requirement's scenarios.
  - Alternatives considered: compose the title only agent-side and have the macOS banner reuse
    the agent's `event.title`. Rejected — the iOS in-app list and the banner already read
    structured `project`/`sessionName` fields, and forcing the banner to depend on a pre-composed
    `event.title` would couple the Swift display to the agent's APNS formatting and lose the
    graceful client-side fallbacks.

- **Decision: agent-side composition lives in a single `composeTitle()` helper** used by
  `title()` in `notification-push.ts`, replacing the `a || b || c` single-winner chain. Form:
  `project && session ? "${project} · ${session}" : (session || project || p.title || "Nexus")`.

- **Decision: Swift-side composition is a `displayTitle` computed property on `NotificationEvent`**
  (`Notification.swift`), consumed by both `TTSObserver.postBanner` (macOS banner) and
  `NotificationDetailScene` (iOS in-app list). Same fallback ladder. The banner composes from
  `event.project` + `event.sessionName`, falling back to `event.title` so existing
  message-style banners are unchanged when project/session are absent.
  - Implementation note: verify `NotificationEvent` carries `project`; if absent, plumb it from
    the payload (the agent already sends it). Confirm before assuming.

- **Decision: banner gating reads raw `UserDefaults.standard`** via
  `object(forKey: "nx.notifications.bannerEnabled") as? Bool ?? true`, matching the existing
  ducking-read precedent in `TTSObserver` (do not thread an `@AppStorage` binding into the
  cross-platform framework). `.object ?? true`, never `.bool` (which defaults absent → false).

- **Decision: grant re-check is log-only.** `getNotificationSettings` after `requestAuthorization`
  in `nexusApp.swift`, logging `authorizationStatus` + `alertStyle`. No re-prompt (ineffective
  post-denial), no UI affordance (deferred).

## Risks / Trade-offs
- **Behavioral break:** off now suppresses banners. Mitigation: default is `true`; only an
  explicit-off user is affected, and that is the intended fix.
- **TS/Swift rule drift:** two copies of the format could diverge. Mitigation: identical literal,
  single middot, covered by spec scenarios; a unit test on each side asserts the four fallback
  cases.
- **Banner title regression:** composing `project · session` could hide a message-style title.
  Mitigation: `displayTitle` falls back to `event.title` when project/session absent, and the
  body always carries the message.
- **iOS push verification** of the title is only observable once APNS provisioning (`nx-gsgvk`)
  lands; the agent-side `composeTitle()` unit test is the runtime evidence until then.

## Migration Plan
No data migration. The `nx.notifications.bannerEnabled` key already exists and round-trips; this
change only adds consumers. Rollback = revert the guards and the formatter; the key stays valid.

## Open Questions
- None blocking. (In-app "open System Settings" affordance intentionally deferred.)
