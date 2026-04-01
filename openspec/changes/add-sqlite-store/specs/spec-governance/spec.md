# Capability: Spec Governance

## ADDED Requirements

### Requirement: The system MUST track spec lifecycle status in SQLite
The agent MUST store discovered specs in the `specs` table with status transitions: `unread → read → approved → rejected → applied → archived`. The spec watcher MUST write to this table instead of in-memory state.

#### Scenario: New spec discovered
Given the spec watcher finds a new spec "add-user-auth" in project "oo"
When the spec is not in the database
Then it is inserted with status='unread', title/summary parsed from proposal.md, and proposal_hash computed

#### Scenario: Spec already tracked
Given "oo/add-user-auth" is already in the database with status='approved'
When the spec watcher polls and finds it unchanged (same proposal_hash)
Then only tasks_done/tasks_total are updated if changed

#### Scenario: Spec modified after approval
Given "oo/add-user-auth" has status='approved' and proposal_hash='abc123'
When the spec watcher detects proposal.md changed (new hash='def456')
Then status resets to 'unread', read_at and approved_at are cleared, and TTS announces the modification

#### Scenario: Spec archived on disk
Given "oo/add-user-auth" has status='applied' in the database
When the spec watcher no longer finds it in openspec/changes/ (moved to archive)
Then status updates to 'archived' with archived_at timestamp

### Requirement: The TUI MUST surface specs for review
The TUI MUST display unread/pending specs with a review screen accessible via keyboard shortcut, showing proposal details and approve/reject actions.

#### Scenario: Unread spec count in status bar
Given 3 specs have status='unread' across all projects
When the TUI renders the status bar
Then it shows "3 specs pending review"

#### Scenario: Auto-mark as read on open
Given spec "oo/add-user-auth" has status='unread'
When Leo opens its detail view in the TUI
Then status transitions to 'read' and read_at is set

#### Scenario: Approve spec
Given spec "oo/add-user-auth" has status='read'
When Leo presses the approve key
Then status transitions to 'approved' and approved_at is set

#### Scenario: Reject spec
Given spec "oo/add-user-auth" has status='read'
When Leo presses the reject key and provides a reason
Then status transitions to 'rejected', rejected_at is set, and rejection_reason is stored

### Requirement: MCP MUST expose spec approval tools
The nexus-mcp binary MUST provide `approve_spec` and `reject_spec` tools for AI assistant consumption.

#### Scenario: Approve via MCP
Given spec "oo/add-user-auth" has status='read' or 'unread'
When an AI assistant calls approve_spec with project="oo" and spec="add-user-auth"
Then the spec status transitions to 'approved' via the agent HTTP API
