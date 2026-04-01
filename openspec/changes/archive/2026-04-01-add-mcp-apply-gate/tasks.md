# Implementation Tasks

<!-- beads:epic:nx-h27 -->

## MCP Batch

- [x] [1.1] [P-1] Fix agent_base_url() default port from 7401 to 7402 in nexus-mcp/src/main.rs:91 [beads:nx-qtw]
- [x] [1.2] [P-1] Add apply_spec tool definition to tool_definitions() with project+name params [beads:nx-wde]
- [x] [1.3] [P-1] Add apply_spec execution branch in execute_tool() — GET status, return is_error on non-approved [beads:nx-6on]
- [x] [1.4] [P-2] Delete stale tmp files in crates/nexus-mcp/src/ (tmp.pPgY4YFiID.rs, tmp.D6agT5Dan8.rs, tmp.qr03bjamHx.rs) [beads:nx-l67]

## Test Batch

- [x] [2.1] Verify apply_spec returns success for approved spec (manual: cargo run + curl) [beads:nx-dca]
- [x] [2.2] Verify apply_spec returns is_error=true for unapproved spec [beads:nx-wt8]
- [x] [2.3] Verify port default fix — nexus-mcp hits agent HTTP on 7402 without env var [beads:nx-nun]
