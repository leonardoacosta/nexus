# notification-store Specification

## Purpose
TBD - created by archiving change add-sqlite-analytics. Update Purpose after archive.
## Requirements
### Requirement: The system MUST persist notifications to SQLite for searchable history
The receiver service MUST write delivered and suppressed notifications to the `notifications` table, enabling searchable, filterable notification history that survives restarts.

#### Scenario: Delivered notification persisted
Given a TTS notification "Build complete for oo" is delivered
When delivery succeeds
Then a row is inserted with message, type, project="oo", channels=["tts","banner"], delivered=true

#### Scenario: Suppressed notification persisted
Given a notification is suppressed by DND mode
When the suppression check fires
Then a row is inserted with delivered=false and suppressed=true

#### Scenario: Query notification history
Given 50 notifications have been delivered today
When GET /analytics/notifications?hours=24 is called
Then the response contains all 50 notification records with timestamps and delivery status

