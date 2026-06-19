# Proposal: API Error Notification

## Why

When a Claude Code session hits an Anthropic API error (`API Error: 529 Overloaded`,
`API Error: 500`, etc.), Leo gets no signal unless the session actually crashes. The common
case is a **retryable** error: CC prints `API Error: 529 Overloaded`, retries, and keeps
going. The session never stops, so `sessionStopRule` never fires and Nexus stays silent —
a session can stall for minutes against an overloaded API with zero visibility.

The terminal-crash case (`stop_reason="api_error"`) already fires a **desktop-only**
notification via `sessionStopRule`, but with no spoken alert.

This change makes every API error — mid-session retryable AND terminal crash — fire a
**desktop + TTS** notification, throttled so an outage storm produces one alert per session
per window rather than talking over itself.

## What Changes

- **Mid-session detection (new):** extend the transcript tail-watcher
  (`apps/agent/src/credentials/token-stream/tail-watcher.ts`), which already tails the exact
  CC transcript JSONL, to detect `isApiErrorMessage: true` lines and emit a `notification`
  socket event. No new file watcher, no new data source.
- **New classification rule:** add `apiErrorRule` to `hook-rules.ts` routing to `desktop` +
  `tts` with `priority: high` and `severity: error`.
- **Crash-stop TTS:** the `stop_reason="api_error"` path moves from `sessionStopRule`
  (desktop-only) to `apiErrorRule` (desktop + TTS). `sessionStopRule` keeps all non-api
  crash reasons.
- **Throttle:** reuse the existing 30s per-session suppression window in `hook-trigger.ts`,
  keyed `api_error:<session>`, so repeated 529s during a sustained outage collapse to one
  alert per session per window.

## Impact

- No DB migration — reuses the `notifications` table, `severity` column, and the full
  manager -> router -> SSE -> Swift TTS/banner chain unchanged.
- Behavior change: `api_error` crash notifications now also speak (previously silent banner).
- Affected capability: `notification-store`.

## Context

- depends on: `add-tts-playback-queue`
- touches: `apps/agent/src/notifications/hook-rules.ts`, `apps/agent/src/notifications/hook-trigger.ts`, `apps/agent/src/credentials/token-stream/tail-watcher.ts`, `apps/agent/src/types/socket-events.ts`

`add-tts-playback-queue` (in-flight) serializes TTS playback; landing it first means
api-error TTS bursts queue cleanly instead of overlapping. Soft dependency — both can be
authored in parallel.
