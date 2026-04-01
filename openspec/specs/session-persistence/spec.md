# session-persistence Specification

## Purpose
TBD - created by archiving change add-sqlite-store. Update Purpose after archive.
## Requirements
### Requirement: The system MUST persist sessions to SQLite with write-through
The SessionRegistry MUST write session data to the `sessions` table on start, heartbeat, and stop events. Sessions MUST survive agent restarts and be loadable from the database on startup.

#### Scenario: Session start persisted
Given a new CC session registers via socket event
When the SessionRegistry creates the session entry
Then a corresponding row is inserted into the sessions table

#### Scenario: Session survives restart
Given 3 active sessions are in the database
When the agent restarts
Then the SessionRegistry loads all non-ended sessions from SQLite on startup

#### Scenario: Session end persisted
Given session "abc" is active in the database
When a session stop event arrives
Then ended_at is set and status is updated in the database

