# Proposal: TTS Quota Exhaustion Alert

## Change ID
`add-tts-quota-alert`

## Summary
Emit a one-time desktop notification when ElevenLabs TTS first fails (quota exhaustion, auth error, etc.), so the user knows immediately instead of discovering the silent fallback to system TTS days later.

## Context
- Extends: `crates/nexus-agent/src/services/receiver/delivery.rs` (process_speak_request ElevenLabs error path)
- Related: Just-discovered issue where ElevenLabs quota was exhausted (4/49,959 credits) and agent silently fell back to macOS `say` with no user notification

## Motivation
The current ElevenLabs failure path is completely silent — a `warn!()` log line that nobody reads, then a fallback to system TTS. The user only discovers the degradation by noticing the voice sounds different. With quota-based APIs, this is a predictable failure mode that should be surfaced proactively. A single desktop alert on first failure gives immediate awareness without adding complexity to the TUI or probing external APIs.

## Requirements

### Req-1: First-failure desktop alert
When ElevenLabs TTS fails for the first time in an agent session, send a desktop notification (via the existing `show_notification` path) informing the user of the failure and that system TTS is being used as fallback. Subsequent failures in the same session do NOT trigger additional alerts.

### Req-2: Include error context in alert
The alert message includes the failure reason extracted from the ElevenLabs API response (e.g., "quota exceeded", "invalid API key", "rate limited") so the user knows what to fix.

### Req-3: Session-scoped deduplication
Track "has ElevenLabs failed this session" via an in-process `AtomicBool` or similar. Resets on agent restart — if the agent restarts and ElevenLabs still fails, the alert fires again (appropriate since the user may have fixed the issue between restarts).

## Scope
- **IN**: One-time desktop alert on first ElevenLabs failure, error context extraction, session-scoped dedup flag
- **OUT**: TUI health integration, periodic quota probing, `/v1/user/subscription` API calls, notification mode auto-switching, persistent failure tracking across restarts

## Impact
| Area | Change |
|------|--------|
| `delivery.rs` | Add alert in ElevenLabs error branch (~10 lines) |
| `delivery.rs` or `service.rs` | Add `AtomicBool` for dedup tracking |

## Risks
| Risk | Mitigation |
|------|-----------|
| Alert itself could fail if terminal-notifier is broken | Already handled by existing error logging in show_notification |
| Noisy if agent restarts frequently | KeepAlive with RestartSec=5 means restarts are rare; one alert per restart is acceptable |
