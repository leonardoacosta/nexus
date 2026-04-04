# Proposal: Credential Status MCP Tool + HTTP Endpoint

## Change ID
`add-credential-mcp`

## Summary
Add a `GET /credentials` HTTP endpoint to the agent that exposes sanitized credential pool status
(no tokens, no file paths, relative times only), and create a new `nexus-mcp` crate that speaks
MCP stdio protocol (JSON-RPC 2.0) to proxy agent HTTP endpoints for AI assistant integration.

## Context
- Extends: `crates/nexus-agent/src/http_handlers.rs` (new handler), `crates/nexus-agent/src/main.rs` (route registration)
- Related: `add-credential-rotation` (implements the `CredentialPool` service this feature reads from)
- Reuses: existing `/statusline` and `/recommend` endpoints proxied through MCP tools

## Motivation
AI assistants (like Nova or other Claude Code instances) need programmatic access to credential pool
status to make informed decisions about session scheduling and rate limit awareness. Currently this
data is only available internally to the agent. Exposing it via HTTP allows local tooling to query
it, and wrapping it in an MCP stdio server enables zero-config integration with Claude Code's MCP
settings -- any assistant can call `get_credential_status` to check which accounts have capacity
before starting work.

## Requirements

### Req-1: Credential Status HTTP Endpoint
The agent exposes `GET /credentials` on port 7401 that returns a JSON object with: `active_account`
(string), `debounce_active` (bool), `last_swap` (object with `account` and `seconds_ago`),
`accounts` (array of sanitized account objects with `name`, `active`, `expired`, `utilization`,
`five_hour`, `seven_day`, `last_polled_seconds_ago`), and `best_available` (string or null). The
response MUST omit `access_token` and file `path` fields. All timestamps are expressed as relative
durations (`resets_in_minutes`, `seconds_ago`) not absolute timestamps.

### Req-2: MCP Stdio Server Binary
A new `crates/nexus-mcp/` crate produces a `nexus-mcp` binary that speaks the MCP stdio protocol
(JSON-RPC 2.0 over stdin/stdout). It implements `initialize`, `tools/list`, and `tools/call`
JSON-RPC methods. No full MCP SDK dependency -- minimal hand-rolled implementation.

### Req-3: MCP Tool — get_credential_status
The `get_credential_status` tool calls `GET http://{host}:{port}/credentials` on the agent and
returns the JSON response. Description: "Get the status of all Claude Code credential accounts
including usage, rate limits, and active account."

### Req-4: MCP Tool — get_sessions
The `get_sessions` tool calls `GET http://{host}:{port}/statusline` on the agent and returns the
active sessions JSON. Description: "List all active Claude Code sessions across all machines."

### Req-5: MCP Tool — get_recommendations
The `get_recommendations` tool calls `GET http://{host}:{port}/recommend` on the agent and returns
work recommendations. Description: "Get AI-generated work recommendations based on current project
state."

### Req-6: MCP Server Configuration
The MCP binary reads `NEXUS_AGENT_HOST` (default `127.0.0.1`) and `NEXUS_AGENT_PORT` (default
`7401`) environment variables to locate the agent. Users add it to Claude Code MCP settings as:
```json
{ "mcpServers": { "nexus": { "command": "nexus-mcp", "args": [] } } }
```

## Scope
- **IN**: `GET /credentials` endpoint with sanitized output, `nexus-mcp` crate with 3 MCP tools,
  env var configuration, workspace Cargo.toml membership
- **OUT**: MCP resources/prompts (tools only), authentication between MCP and agent, TUI
  credential display, credential write/swap operations via MCP, full MCP SDK dependency

## Impact
| Area | Change |
|------|--------|
| nexus-agent/http_handlers | New `credentials_handler` function + response types |
| nexus-agent/main | Register `GET /credentials` route |
| crates/nexus-mcp (new) | New crate: MCP stdio binary with 3 tools |
| Cargo.toml (workspace) | Add `nexus-mcp` to workspace members (already `crates/*` glob) |

## Risks
| Risk | Mitigation |
|------|-----------|
| Agent not running when MCP tool called | Return clear error message: "nexus-agent not reachable at {host}:{port}" |
| MCP protocol version drift | Pin to MCP protocol version 2024-11-05; minimal surface area reduces drift risk |
| Credential data leakage | Response explicitly omits access_token and path; only names and utilization exposed |
| Stdin/stdout contention | MCP binary uses stderr for logging (tracing), stdout exclusively for JSON-RPC |
