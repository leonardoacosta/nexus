# Spec: Meeting-Aware Notification Queuing

## ADDED Requirements

### Requirement: Meeting detection bridge
The ReceiverService SHALL spawn a background task that polls SuppressionChecker every 30
seconds. When a video call is detected and focus_session is not active, it MUST activate
focus_session mode on the NotificationBatchBuffer. When no video call is detected and
focus_session is active, it MUST deactivate focus_session and trigger a summary flush.

#### Scenario: User enters a meeting
Given the agent is running and no meeting is active
When a Zoom/Teams/Meet call is detected by the suppression checker
Then the NotificationBatchBuffer focus_session mode is activated
And incoming notifications are queued instead of delivered

#### Scenario: User leaves a meeting
Given the agent is running and focus_session is active due to meeting detection
When the suppression checker no longer detects a video call
Then focus_session mode is deactivated
And all queued notifications are flushed as a single summarized TTS message

#### Scenario: Agent starts during a meeting
Given a video call is already active when the agent starts
When the first meeting detection poll runs
Then focus_session mode is activated (no spurious flush of empty queue)

### Requirement: Summary message format
When flushing queued notifications after a meeting, the system SHALL produce a concise
natural-language summary grouping by notification type.

#### Scenario: Mixed notification types queued
Given 2 build notifications, 1 spec approval, and 2 session updates were queued
When the meeting ends and flush is triggered
Then TTS delivers: "5 notifications while away: 2 builds passed, spec approved, 2 session updates"

#### Scenario: Single notification queued
Given 1 build notification was queued during the meeting
When the meeting ends
Then TTS delivers the original message as-is (no summary wrapper)

#### Scenario: No notifications queued
Given no notifications arrived during the meeting
When the meeting ends
Then no TTS is delivered (silent deactivation)

### Requirement: Meeting state HTTP exposure
The existing `/health` or `/status/notifications` endpoint SHALL include a `meeting_active`
boolean field so the TUI MUST be able to display meeting detection state.

#### Scenario: Health endpoint during meeting
Given a meeting is active
When GET /status/notifications is called
Then the response includes `"meeting_active": true`
