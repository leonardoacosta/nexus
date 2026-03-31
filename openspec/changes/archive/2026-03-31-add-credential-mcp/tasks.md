# Implementation Tasks

<!-- beads:epic:nexus-otqd -->

## API Batch

- [ ] [1.1] [P-1] Add `CredentialsResponse` and supporting types to `http_handlers.rs` — sanitized structs with `#[serde(skip_serializing_if)]` for optional fields, relative time helpers [owner:api-engineer] [beads:nexus-uozf]
- [ ] [1.2] [P-1] Implement `credentials_handler` in `http_handlers.rs` — reads `CredentialPool` from `AppState`, computes relative times, omits sensitive fields [owner:api-engineer] [beads:nexus-j5qi]
- [ ] [1.3] [P-2] Register `GET /credentials` route in `main.rs` and add import [owner:api-engineer] [beads:nexus-rwvj]
- [ ] [1.4] [P-2] Add unit tests for `credentials_handler` response shape — verify no `access_token`/`path` leakage, correct relative times, empty pool case [owner:api-engineer] [beads:nexus-8x7f]

## MCP Batch

- [ ] [2.1] [P-1] Create `crates/nexus-mcp/Cargo.toml` with dependencies (serde, serde_json, reqwest, tokio) and `[[bin]]` entry for `nexus-mcp` [owner:api-engineer] [beads:nexus-dbua]
- [ ] [2.2] [P-1] Implement JSON-RPC 2.0 message types — `Request`, `Response`, `Error` structs with serde serialization [owner:api-engineer] [beads:nexus-t9sd]
- [ ] [2.3] [P-1] Implement MCP protocol handler — `initialize`, `tools/list`, `tools/call` dispatch with method-not-found error for unknown methods [owner:api-engineer] [beads:nexus-xb8l]
- [ ] [2.4] [P-1] Implement `get_credential_status` tool — HTTP GET to `/credentials`, format as MCP tool result [owner:api-engineer] [beads:nexus-16x3]
- [ ] [2.5] [P-1] Implement `get_sessions` tool — HTTP GET to `/statusline`, format as MCP tool result [owner:api-engineer] [beads:nexus-zfys]
- [ ] [2.6] [P-1] Implement `get_recommendations` tool — HTTP GET to `/recommend`, format as MCP tool result [owner:api-engineer] [beads:nexus-x58z]
- [ ] [2.7] [P-2] Implement env var configuration — `NEXUS_AGENT_HOST` and `NEXUS_AGENT_PORT` with defaults [owner:api-engineer] [beads:nexus-673d]
- [ ] [2.8] [P-2] Implement stdin/stdout main loop — line-delimited JSON-RPC read from stdin, write to stdout, tracing to stderr [owner:api-engineer] [beads:nexus-7152]
- [ ] [2.9] [P-2] Add error handling for agent unreachable — clear error messages in MCP tool result format [owner:api-engineer] [beads:nexus-nq1s]

## E2E Batch

- [ ] [3.1] Verify `cargo build -p nexus-mcp` produces `nexus-mcp` binary [owner:e2e-engineer] [beads:nexus-8isw]
- [ ] [3.2] Verify `GET /credentials` returns valid JSON with no sensitive fields when agent is running with credential pool [owner:e2e-engineer] [beads:nexus-yg57]
- [ ] [3.3] Verify `nexus-mcp` responds to initialize + tools/list via stdin/stdout pipe [owner:e2e-engineer] [beads:nexus-nffy]
