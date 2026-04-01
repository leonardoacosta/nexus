# Capability: MCP Specs Tool

## ADDED Requirements

### Requirement: The system MUST expose get_all_specs MCP tool
The nexus-mcp binary MUST binary exposes a `get_all_specs` tool that proxies `GET /specs/all` for AI assistant consumption.

#### Scenario: Tool returns cross-project spec status
Given the agent is running and has polled all projects
When an AI assistant calls `get_all_specs` via MCP
Then the tool returns JSON with all projects' spec names, task completion, and beads status

#### Scenario: Agent unreachable
Given the agent is not running
When an AI assistant calls `get_all_specs`
Then the tool returns an error result with message "Nexus agent unreachable"
