# approval-gate Specification

## Purpose
TBD - created by archiving change add-sqlite-store. Update Purpose after archive.
## Requirements
### Requirement: The system MUST block /apply and /apply:all for unapproved specs
Both `/apply` and `/apply:all` MUST check the spec's status in the database before execution. Only specs with `status='approved'` are allowed to proceed.

#### Scenario: Approved spec proceeds
Given spec "oo/add-user-auth" has status='approved' in the database
When `/apply add-user-auth` is run in the oo project
Then execution proceeds normally

#### Scenario: Unapproved spec blocked
Given spec "oo/add-user-auth" has status='unread' in the database
When `/apply add-user-auth` is run
Then execution is blocked with message "Spec not approved. Review in Nexus TUI or call approve_spec via MCP."

#### Scenario: apply:all filters to approved only
Given 5 specs exist: 3 approved, 1 read, 1 unread
When `/apply:all` builds its wave plan
Then only the 3 approved specs are included; the other 2 are listed as "pending approval"

#### Scenario: Spec not in database (new project)
Given a spec exists on disk but the agent hasn't polled it yet (no database entry)
When `/apply` is run
Then it falls through gracefully (no block) — the gate only blocks specs with explicit non-approved status

