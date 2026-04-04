# Capability: Spec Watcher Service

## ADDED Requirements

### Requirement: The system MUST proactively poll spec and beads status
The agent MUST runs a background service that enumerates all registered projects via `ProjectRegistry::all()`, polls `openspec list --json` and `bd stats --json` per project every 60 seconds, and updates the ProjectStatusCache.

#### Scenario: Normal polling cycle
Given 5 registered projects with openspec directories
When the 60-second poll interval fires
Then the service runs collectors for each project and updates the cache

#### Scenario: Project without openspec directory
Given a registered project at ~/dev/cc with no openspec/ directory
When the poll cycle enumerates projects
Then that project is skipped without error

#### Scenario: Staggered polling to reduce load
Given 15 registered projects
When the poll cycle runs
Then projects are polled in batches of 3-5 with a short delay between batches

### Requirement: The system MUST detect state transitions and emit TTS notifications
The service MUST compares each poll result with the previous snapshot and emits TTS notifications for new specs, task completion changes, all-tasks-complete, and spec archived events.

#### Scenario: New spec detected
Given project "oo" had 2 specs in the previous poll
When the current poll finds 3 specs
Then a TTS notification is emitted: "New spec add-user-auth in oo"

#### Scenario: Task completion progress
Given spec "add-user-auth" in "oo" was at 3/10 tasks
When the current poll finds 7/10 tasks
Then a TTS notification is emitted: "oo: add-user-auth progress 7 of 10 tasks"

#### Scenario: All tasks complete
Given spec "add-user-auth" in "oo" was at 9/10 tasks
When the current poll finds 10/10 tasks
Then a TTS notification is emitted: "oo: add-user-auth all tasks complete — ready to archive"

#### Scenario: Spec archived
Given spec "add-user-auth" was present in "oo" changes last poll
When the current poll no longer finds it in changes (moved to archive)
Then a TTS notification is emitted: "oo: add-user-auth archived"

#### Scenario: Notification coalescing
Given 3 specs changed in the same poll cycle across 2 projects
When notifications are generated
Then they are batched into a single TTS message within a 5-second window
