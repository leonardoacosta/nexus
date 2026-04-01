# Capability: Cross-Project Spec Endpoint

## ADDED Requirements

### Requirement: The system MUST expose GET /specs/all for cross-project aggregate
The agent MUST exposes a `GET /specs/all` HTTP endpoint returning aggregated openspec + beads status for all registered projects in one response.

#### Scenario: Normal response with multiple projects
Given 3 projects have active specs
When GET /specs/all is called
Then the response contains an array of project entries with code, name, specs array (name, status, completedTasks, totalTasks), and beads summary (open, closed, ready counts)

#### Scenario: Empty projects included
Given a project "cc" has no openspec directory
When GET /specs/all is called
Then "cc" appears with an empty specs array and null beads summary

#### Scenario: Cache-warmed response is instant
Given the spec watcher has polled all projects within the last 60 seconds
When GET /specs/all is called
Then the response is served from cache without running any subprocess collectors

### Requirement: The system MUST support ProjectRegistry iteration
ProjectRegistry MUST exposes an `all()` method returning all registered project paths.

#### Scenario: Enumerate all projects
Given projects.json contains 15 project entries
When `ProjectRegistry::all()` is called
Then it returns 15 ProjectPath entries with code, name, and cwd
