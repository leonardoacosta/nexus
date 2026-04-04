# Spec Delta: HTTP Hooks Receiver Endpoint

## ADDED Requirements

### Requirement: POST /hooks Endpoint
nexus-agent SHALL expose a `POST /hooks` endpoint on port 7401 that accepts JSON payloads from
Claude Code HTTP hooks and telemetry.sh, dispatching based on the event type.

#### Scenario: SessionStart hook received
Given cc sends a SessionStart HTTP hook to `POST /hooks`
When the payload contains `"hook_event_name": "SessionStart"` with session metadata
Then nexus-agent registers the session in SessionRegistry (same as socket session_start)
And returns HTTP 200 with `{"ok": true}`

#### Scenario: StopFailure hook received
Given cc sends a StopFailure HTTP hook to `POST /hooks`
When the payload contains `"hook_event_name": "StopFailure"` with error details
Then nexus-agent forwards a LifecycleEvent::Error to the NotificationEngine
And returns HTTP 200 with `{"ok": true}`

#### Scenario: Session summary received
Given telemetry.sh POSTs a session summary to `POST /hooks`
When the payload contains `"event": "session_summary"` with tool_counts, failure_count, duration_ms
Then nexus-agent stores the summary associated with the session_id
And returns HTTP 200 with `{"ok": true}`

#### Scenario: Unknown event type
Given a POST to `/hooks` with an unrecognized event type
When the payload does not match any known hook_event_name or event field
Then nexus-agent returns HTTP 200 with `{"ok": true, "ignored": true}`
And logs the unknown event at debug level

#### Scenario: Malformed JSON
Given a POST to `/hooks` with invalid JSON
When the payload cannot be deserialized
Then nexus-agent returns HTTP 400 with an error message

### Requirement: SessionSummary Event Type
nexus-agent SHALL support a `session_summary` event variant that stores per-session monitoring data
including tool usage counts, failure count, compaction count, agent spawn count, duration, and model.

#### Scenario: Summary stored for active session
Given session "abc-123" is registered in SessionRegistry
When a session_summary event arrives for session_id "abc-123"
Then the summary data is stored alongside the session entry
And is retrievable via existing session status APIs

#### Scenario: Summary received for unknown session
Given no session with id "xyz-789" exists in SessionRegistry
When a session_summary event arrives for session_id "xyz-789"
Then the summary is stored in a pending summaries map
And is associated if the session registers later, or cleaned up after 5 minutes
