---
status: draft
order: 0715a
---

# Dedupe permission_request notifications within a short per-session window

## Context

- depends on: none
- touches: `apps/agent/src/notifications/hook-trigger.ts`, `apps/agent/src/notifications/hook-trigger.test.ts`, `openspec/specs/hooks-endpoint/spec.md`

Found via `/openspec:explore` (2026-07-15), investigating "we're receiving multiple nx
notifications for the same hook events." Runtime evidence (`journalctl --user -u nexus-agent`,
buildSha `61544ed6`, 6-hour sample): every `permission_request` socket event arrives as an exact
pair — 46/46 pairs observed, ~50-150ms apart, same `session_id` — each pair producing two full
notification deliveries (2 pushes x 3 devices = 6 pushes, plus duplicate TTS-eligible sends) for
one logical permission prompt.

Root cause traced to `~/.claude/settings.json` (a separate repo, `~/dev/cc`): two independent CC
hook lifecycle points both classify to `EVENT_TYPE=permission_request` in
`~/.claude/scripts/hooks/telemetry.sh` — `PreToolUse` matcher `AskUserQuestion` (fires early,
bell-only by its own header comment) and the native `PermissionRequest` hook (matcher `""`).
Both call `nx_send`, so one logical permission prompt reaches this agent as two socket events.
That upstream fix is tracked separately (bead `nx-09shh.1`, different repo/governance lane — not
in scope here).

`hookRules.permission_request`'s suppression key is currently hardcoded `null`
("never suppress — always fire"), a deliberate decision recorded in
`openspec/specs/hooks-endpoint/spec.md` (`### Requirement: Suppression dedupes within configured
windows`, `#### Scenario: permission_request never deduplicates`). That decision was made to
ensure genuinely distinct permission requests each notify — it did not anticipate a same-session
double-emission arriving within ~150ms. This proposal narrows it: keep permission_request
effectively un-suppressed for real, temporally-separated prompts, while collapsing exact
same-session duplicates that arrive within a couple of seconds.

## What Changes

- `hook-trigger.ts`'s `suppressionKey()` returns `permission_request:<session_id>` (instead of
  `null`) for `eventType === "permission_request"`, reusing the existing
  `suppressionCache`/`SUPPRESSION_WINDOW_MS` machinery — but permission_request gets its OWN,
  much shorter window (`PERMISSION_REQUEST_SUPPRESSION_WINDOW_MS = 2_000`) rather than the
  30-second `SUPPRESSION_WINDOW_MS` used by `hook_failure`/`session_stop`/`api_error`. A 30s
  window would risk swallowing a second, genuinely distinct permission request in the same
  session (e.g. two different tools each needing approval a few seconds apart); 2s comfortably
  covers the observed ~150ms duplicate-emission gap with wide margin while leaving normal
  sequential prompts untouched.
- Keyed on `session_id` alone, not `session_id:tool` — the observed duplicate pairs logged an
  empty `tool` field on both emissions (the `PreToolUse(AskUserQuestion)` path does not reliably
  carry the underlying tool name), so a tool-qualified key would not have collapsed the actual
  duplicates seen in production.
- `openspec/specs/hooks-endpoint/spec.md`: amend `### Requirement: Suppression dedupes within
  configured windows` — update the suppression-key table row for `permission_request`, replace
  `#### Scenario: permission_request never deduplicates` with a scenario asserting the SAME
  `session_id` within 2 seconds is suppressed, plus a new scenario asserting a DIFFERENT
  `session_id` (or the same session after the window expires) still fires — mirroring the
  existing `hook_failure` "different key" / "window expires" scenario shapes.

## Testing

- Unit: `hook-trigger.test.ts` — two `permission_request` payloads, same `session_id`, fired
  back-to-back → second dispatch is suppressed (assert `manager.send` called once, not twice).
  Two `permission_request` payloads with different `session_id`s fired back-to-back → both
  dispatch. A `permission_request` payload arriving after `PERMISSION_REQUEST_SUPPRESSION_WINDOW_MS`
  has elapsed for the same `session_id` → dispatches again (mirrors the existing fake-timer
  pattern already used for `hook_failure`'s 30s-expiry test in this file).
- No e2e/UI surface — this is a pure backend dedup-cache change with no schema or route shape
  change; existing `notifications.test.ts` / `hook-trigger.test.ts` suites cover the affected path.
