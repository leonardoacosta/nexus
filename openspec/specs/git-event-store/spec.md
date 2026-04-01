# git-event-store Specification

## Purpose
TBD - created by archiving change add-sqlite-consolidation. Update Purpose after archive.
## Requirements
### Requirement: The system MUST persist git events to SQLite
The git watch service MUST write branch switch, new commit, and detached head events to the `git_events` table with timestamp, project, event type, and ref details, replacing fire-and-forget tracing logs.

#### Scenario: Branch switch persisted
Given project "oo" switches from branch "main" to "feat/auth"
When the git watcher detects the change
Then a row is inserted with event_type="branch_switch", old_ref="main", new_ref="feat/auth"

#### Scenario: New commit detected
Given project "nx" has a new commit on branch "main"
When the git watcher polls
Then a row is inserted with event_type="new_commit", new_ref containing the commit SHA

