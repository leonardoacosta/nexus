# Proposal: MCP Apply Gate

## Change ID
`add-mcp-apply-gate`

## Summary
Add an `apply_spec` MCP tool to nexus-mcp that actively gates spec execution by checking approval
status, and fix the MCP port default mismatch (7401→7402).

## Context
- Extends: `crates/nexus-mcp/src/main.rs` (tool list + execution handler)
- Related: `approval-gate` spec (defines gate behavior), `mcp-specs-tool` spec (existing MCP tools)
- Depends on: `GET /specs/{project}/{name}/status` endpoint (already shipped in http_handlers.rs:1353)

## Motivation
The approval gate infrastructure exists (SQLite specs table, HTTP endpoints, TUI approve/reject,
MCP approve_spec tool) but there's no Nexus-side enforcement point that blocks execution of
unapproved specs. CC sessions running `/apply` directly should not be gated — the gate should
only fire when the apply is mediated through Nexus MCP tools. This preserves user autonomy for
direct invocations while enforcing governance when Nexus orchestrates.

Additionally, the MCP crate defaults `NEXUS_AGENT_PORT` to 7401 but the agent HTTP server runs
on 7402. All existing tools silently hit the wrong port unless the env var is explicitly set.

## Requirements
### Req-1: Active apply gate MCP tool
The nexus-mcp binary MUST expose an `apply_spec` tool that checks approval status via the agent
HTTP API and returns `is_error=true` if the spec is not in `approved` status. This is gate-only —
no lifecycle transitions.

### Req-2: Port default fix
The `agent_base_url()` function MUST default `NEXUS_AGENT_PORT` to `7402` to match the actual
agent HTTP port.

## Scope
- **IN**: New `apply_spec` MCP tool, port default fix, cleanup of tmp files in nexus-mcp/src/
- **OUT**: Modifying `/apply` or `/apply:all` CC skills, lifecycle transitions (applied/archived), new HTTP endpoints

## Impact
| Area | Change |
|------|--------|
| nexus-mcp | +1 tool definition, +1 execution branch, port fix |
| CC sessions | Sessions using Nexus MCP gain automatic apply gating |
| Existing behavior | No change to direct `/apply` — only MCP-mediated applies are gated |

## Risks
| Risk | Mitigation |
|------|-----------|
| Port fix breaks envs that explicitly set 7401 | Port fix only changes the default; explicit NEXUS_AGENT_PORT still honored |
| Spec not yet in DB (agent hasn't polled) | Tool returns clear error: "spec not found — agent may not have polled yet" |
| CC session ignores MCP error | Active mode (is_error=true) makes it structurally hard to ignore |
