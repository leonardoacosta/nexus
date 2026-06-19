# Design: API Error Notification

## Detection source — reuse the transcript tail-watcher

`apps/agent/src/credentials/token-stream/tail-watcher.ts` already tails each session's CC
transcript JSONL incrementally for token/usage extraction. Its `parseLine()` returns `null`
for any line without a `usage` block — which is exactly what an api-error line is. Verified:
real transcripts under `~/.claude/projects/` contain lines with `"isApiErrorMessage": true`.

**Approach:** add a second extraction branch in the tail-watcher's line loop. When a line has
`isApiErrorMessage === true` (or `message.content` / top-level text matching `^API Error:`),
extract the error text and invoke a new injected callback (`onApiError(sessionId, text)`)
alongside the existing `onTurns`. The callback posts a `notification` socket event through the
same internal path the dispatcher already uses, so it flows into `hook-trigger` ->
`NotificationManager` with zero new transport.

**Risk:** the tail-watcher must be active for the session for mid-session detection to work.
It runs as part of token-stream analytics. If a session has no active tail-watcher, only the
crash-stop path fires. Implementer MUST confirm the tail-watcher lifecycle covers live
sessions; if not, gate mid-session detection behind that lifecycle and note the limitation.

## Classification — new `apiErrorRule`

Add to `apps/agent/src/notifications/hook-rules.ts`:

- Fires when the payload is an api-error event (mid-session emit) OR a stop event with
  `stop_reason === "api_error"`.
- Emits two drafts: `{ channel: "desktop" }` and `{ channel: "tts" }`, both
  `priority: "high"`, body = `prefixBody(project, "api error: <text>")`.
- Set `severity: "error"` so the Swift dashboard surfaces it as an error row.

Modify `sessionStopRule` so its crash branch excludes `api_error` (cedes that reason to
`apiErrorRule`); it keeps `error`, `crash`, `timeout`, `oom`.

## Throttle — reuse existing suppression cache

`hook-trigger.ts` already maintains a per-rule suppression map (`key -> lastFireMs`, 30s
window). Register `apiErrorRule` with suppression key `api_error:<session_id>`. This is the
single most important guard: without it, a multi-minute 529 outage would queue dozens of TTS
utterances. Per-session keying lets concurrent sessions each alert once.

## Event shape

Reuse the existing `notification` socket event (`apps/agent/src/types/socket-events.ts`)
for the mid-session emit rather than inventing a new event type — it already carries
`message`, `project`, `session_id`, and optional `channels`. The mid-session emit sets
`message` to the api-error text and lets `apiErrorRule` own channel/severity classification.
If the rule needs to distinguish mid-session emits from generic notifications, add a thin
discriminator field (e.g. `reason: "api_error"`) to the event rather than a whole new type.

## What is explicitly NOT changing

- No DB migration — `notifications` table, `severity` column, and settings table unchanged.
- No Swift changes — `NotificationFired` already carries `severity` and renders via the
  existing TTS/banner chain.
- No new file watcher, no transcript re-scan, no statusline involvement.
