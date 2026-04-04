# Proposal: Meeting-Aware Notification Queuing

## Change ID
`add-meeting-aware-notifications`

## Summary
Bridge the existing SuppressionChecker (video call detection) to the NotificationBatchBuffer
(focus session mode), so notifications are automatically queued during meetings and delivered
as a summarized TTS batch when the meeting ends.

## Context
- Extends: `crates/nexus-agent/src/services/receiver/suppression.rs`, `notification_batch.rs`,
  `http_router.rs`, `state.rs`
- Related: Existing `SuppressionChecker` detects Zoom/Teams/Meet via wmctrl/pgrep.
  Existing `NotificationBatchBuffer` has `focus_session_active` mode that batches everything.
  These two systems are never wired together — suppression currently drops TTS entirely instead
  of queuing.

## Motivation
When a user is in a video call, TTS notifications are suppressed (dropped). The user misses
important events (build results, spec approvals, session alerts) that happened during the
meeting. Instead of dropping, we should queue messages and deliver a summarized batch when
the meeting ends, so the user gets a quick catch-up without missing anything.

## Requirements

### Req-1: Automatic meeting detection bridge
The agent should periodically check if a video call is active via the existing
SuppressionChecker. When a call is detected, automatically activate the
NotificationBatchBuffer's focus_session mode. When the call ends, deactivate focus_session.

### Req-2: Queued message delivery on meeting end
When focus_session deactivates (meeting ended), flush all queued notifications and deliver
them as a single summarized TTS message. The summary should be concise, e.g.:
"5 notifications while you were away: 2 builds passed, spec approved, 2 session updates"

### Req-3: Meeting state visibility
Expose the current meeting/focus state through the existing health/status HTTP endpoints
so the TUI can display whether the user is detected as in a meeting.

## Scope
- **IN**: Auto-bridge suppression → batching, summarized flush on meeting end, state exposure
- **OUT**: Google Calendar integration, manual meeting toggle (existing DND covers this),
  per-project meeting rules, notification priority filtering during meetings

## Impact
| Area | Change |
|------|--------|
| `services/receiver/state.rs` | Add meeting detection polling loop |
| `services/receiver/suppression.rs` | Add `is_meeting_active()` convenience method |
| `services/receiver/notification_batch.rs` | Add `flush_as_summary()` method |
| `services/receiver/http_router.rs` | Wire meeting state into speak handler, expose in status |
| `services/receiver/service.rs` | Spawn meeting detection task on start |

## Risks
| Risk | Mitigation |
|------|-----------|
| wmctrl not available on some Linux DEs | Fallback to pgrep already exists in SuppressionChecker |
| False positive detection (Zoom open but no call) | 30s cache already debounces; process detection is inherently imprecise — acceptable for v1 |
| Stale focus_session if crash during meeting | On startup, always reset focus_session to false |
