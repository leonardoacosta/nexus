---
status: approved
approved-by: leo@leonardoacosta.dev
approved-at: 2026-04-27T02:53:42-05:00
---
# Proposal: add-hooks-notification-triggers

## Change ID
`add-hooks-notification-triggers`

## Summary
Wire a curated set of high-signal Claude Code hook events into the existing notification pipeline so that `tool_use_fail`, `permission_request`, `hook_failure`, `session_stop` (crash), and `session_summary` (high cost) events surface as desktop / TTS / Slack notifications. Reuse the rule engine in `apps/agent/src/notifications/router.ts` rather than building a parallel dispatch path. Honor user-controlled toggles in the `notification_settings` table (delivered by archived `add-notification-control-dashboard`).

## Context

- **Affects:** `apps/agent/src/routes/hooks.ts`, `apps/agent/src/notifications/router.ts`, `apps/agent/src/notifications/manager.ts`, new `apps/agent/src/notifications/hook-rules.ts`
- **Capability:** extends `hooks-endpoint`
- **HARD dependency — `extend-hooks-event-taxonomy` (`nx-h8uxs`) MUST land first.** The agent currently routes only seven event types through `handleHooks`; the remaining ~13 event types (including `tool_use_fail`, `permission_request`, `hook_failure`) drop into the `unknown` branch and never reach the notification stage. Until taxonomy work expands the recognized set and parses the event-specific fields (`tool_name`, `error_message`, `crash_flag`, etc.), this proposal has no events to fire on.
- **SOFT dependency — `add-notification-control-dashboard` (archived 2026-04-27).** Provides the `notification_settings` row (`tts_enabled`, `banner_enabled`, `ducking_mode`) that this proposal MUST consult before dispatching. Already merged.
- **Sibling — `add-hooks-sse-fanout` (`nx-mfarp`).** Independent: SSE fan-out streams ALL event rows; this proposal selects 5 events for notification delivery. They cannot conflict because they touch different downstream sinks.
- **Predecessor — `restore-hooks-event-persistence` (archived 2026-04-27, commit 436fb37).** Restored the persistence path this proposal sits on top of.
- **Routing policy source of truth:** `~/.claude/scripts/hooks/telemetry.sh` — the cc-side curator already decides what is "high-signal" (lines 28–65, 1165, 1193, 1221–1224). This proposal mirrors that policy verbatim in v1; expansion of the trigger set is out of scope.

## Motivation

### What's missing today

After `restore-hooks-event-persistence` landed, every recognized hook event writes a row to `session_events`. The dashboard can read that history. But the **realtime notification surface** — desktop banners, TTS voice cues, Slack DMs — never receives anything from the `/hooks` endpoint. The notification router ships TTS for `nexus-status` warnings, build completions, and ad-hoc `/notifications/send` calls, but high-signal Claude Code events (a tool failing in a tight retry loop, a permission prompt waiting for user input) are silent.

### Why the curated five

The cc-side telemetry pipeline already classifies events by severity and routes the critical ones (`tool_use_fail`, `permission_request`, `hook_failure`, `StopFailure`, `session_summary`) to Sentry and structured logs. That triage was done thoughtfully — the same five events are the ones a developer wants surfaced as notifications. Mirroring the cc policy keeps a single source of truth for "what counts as high-signal" and avoids drift between the cc and nx halves of the system.

### Five trigger rules, declarative

Each event type maps to a pure function: `(event payload) → { channels: NotificationChannel[]; title: string; body: string; suppressionKey?: string }`. The rule fires from `handleHooks` after the event row is written. Channel dispatch reuses `routeNotificationParallel`; suppression layered via a small per-rule dedupe cache.

| Trigger event | Channels | Suppression |
|---|---|---|
| `tool_use_fail` | desktop + slack | dedupe by `(event_type, tool_name)` within 30s |
| `permission_request` | desktop + tts | none — every prompt audible |
| `hook_failure` | desktop + slack | dedupe by `(event_type, hook_name)` within 30s |
| `session_stop` with crash flag | desktop + slack | dedupe by `session_id` (1 per session) |
| `session_summary` with `cost_usd >= 0.50` | desktop (digest format) | dedupe by `session_id` (1 per session) |

`tts_enabled=false` skips TTS dispatch; `banner_enabled=false` skips desktop dispatch; Slack always fires when selected. (No per-channel toggle for Slack yet — future work.)

## What Changes

### `handleHooks` calls into the rule engine after persistence

After the event row is appended (and any lifecycle side-effect on the `sessions` table runs), the handler invokes a new module — `apps/agent/src/notifications/hook-rules.ts` — that evaluates each registered rule against the event payload. Rules that match emit a notification through `NotificationManager.send()` using the existing buffer + parallel-delivery path.

### `hook-rules.ts` registers 5 declarative rules

The module exports `evaluateHookRules(payload, settings)` returning an array of `Omit<NotificationRow, "id" | "status" | "sentAt">`. Each rule is a small object:

```ts
type HookRule = {
  eventType: string;
  predicate?: (payload: HookEventPayload) => boolean;  // optional: e.g. crash flag, cost threshold
  toNotification: (payload: HookEventPayload) => NotificationDraft;
  suppressionKey: (payload: HookEventPayload) => string | null;
  suppressionWindowMs: number;
};
```

Five rule entries — one per row in the table above. All fields are static / pure; tests build a fixture payload and assert the function output.

### Suppression cache (in-process)

A `Map<string, number>` keyed by `suppressionKey` with `Date.now()` values. On each fire, the rule checks if the key exists and is within `suppressionWindowMs`; if so, the rule returns `null` (skipped). Simple, single-process — sufficient for the agent's single-pod deployment. Cache pruning happens lazily on each access.

### `notification_settings` honored at dispatch time

Before a rule's `NotificationDraft` is converted into a notification send, the trigger filters its `channels` array against the live settings:

- `tts_enabled === false` → drop `"tts"` from channels
- `banner_enabled === false` → drop `"desktop"` from channels
- If channels becomes empty after filtering, skip the send entirely (don't log a no-op delivery)

`ducking_mode` is not consulted — it's a Mac-listener concern (volume), not an agent-side delivery decision.

### Cost threshold for digest

Hardcoded constant `SESSION_SUMMARY_COST_THRESHOLD_USD = 0.5` in v1. Matches the `nexus-status` warn threshold. Future-config: when `notification_settings` grows a `digest_threshold_usd` column, the rule reads it from there. Out of scope for this proposal.

## Impact

### Behavior change

- The `/hooks` endpoint becomes a notification trigger surface. Latency for the five trigger events grows by another ~5–20ms per matching rule (push to buffer + parallel channel dispatch). All other events unchanged.
- Desktop notification volume increases for active developers. Users can opt out via the dashboard toggles delivered by `add-notification-control-dashboard`.
- TTS audibility only fires on `permission_request` — designed to surface interactive prompts that block the cc loop, not to narrate every tool error.

### No schema change

`notification_settings` already exists. `session_events` is not modified. The new `hook-rules.ts` module is additive.

### Test surface

- Unit tests per rule (5 rules × ~3 scenarios each) — fixture payload in, expected `NotificationDraft` or null out.
- Suppression cache tests — fire same key twice within window (second skipped); fire same key after window (delivered).
- One integration test wiring `handleHooks` → `hook-rules` → `NotificationManager`: POST a `tool_use_fail` payload, assert `notifications` table row inserted with `channel="desktop"` and `channel="slack"`.

### Trade-offs accepted

| Trade-off | Decision rationale |
|---|---|
| In-process suppression cache (not Redis) | Agent runs as a single process; cross-pod consistency not needed |
| Hardcoded $0.50 cost threshold | Matches `nexus-status`; promote to config when a second consumer needs it |
| Slack always fires (no per-channel toggle) | Mirror current behavior; add toggle when there's a user complaint, not before |
| 5 trigger events, not 13 | Mirror cc curator's policy; expanding the set is `nx-h8uxs`'s territory, not this proposal's |
| Ducking mode ignored | Volume is a render-layer concern; agent's job is to deliver |
