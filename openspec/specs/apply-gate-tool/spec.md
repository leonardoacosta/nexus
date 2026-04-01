# apply-gate-tool Specification

## Purpose
TBD - created by archiving change add-mcp-apply-gate. Update Purpose after archive.
## Requirements
### Requirement: The system MUST expose apply_spec MCP tool with active gating
The nexus-mcp binary MUST expose an `apply_spec` tool that queries `GET /specs/{project}/{name}/status` and returns `is_error=true` when the spec is not in `approved` status.

#### Scenario: Approved spec returns success
Given spec "oo/add-user-auth" has status='approved' in the database
When an AI assistant calls `apply_spec` with project="oo" name="add-user-auth" via MCP
Then the tool returns success with message "Spec approved. Proceed with /apply."

#### Scenario: Unapproved spec returns error
Given spec "oo/add-user-auth" has status='read' in the database
When an AI assistant calls `apply_spec` with project="oo" name="add-user-auth"
Then the tool returns is_error=true with message "Spec not approved (status: read). Review and approve in Nexus TUI or call approve_spec first."

#### Scenario: Spec not found in database
Given no database entry exists for "oo/new-feature"
When an AI assistant calls `apply_spec` with project="oo" name="new-feature"
Then the tool returns is_error=true with message "Spec oo/new-feature not found in Nexus. Agent may not have polled yet."

#### Scenario: Agent unreachable
Given the agent is not running
When an AI assistant calls `apply_spec`
Then the tool returns is_error=true with message "Nexus agent unreachable"

### Requirement: The MCP port default MUST match the agent HTTP port
The `agent_base_url()` function MUST default `NEXUS_AGENT_PORT` to `7402`.

#### Scenario: Default port resolves correctly
Given NEXUS_AGENT_PORT is not set
When nexus-mcp constructs the base URL
Then it uses port 7402

#### Scenario: Explicit port override still works
Given NEXUS_AGENT_PORT=9000
When nexus-mcp constructs the base URL
Then it uses port 9000

