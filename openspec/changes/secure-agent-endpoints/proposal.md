# Change: Secure agent HTTP/gRPC endpoints with bind-address control and shared-secret auth

## Why
Both gRPC (port 7400) and HTTP (port 7401) bind to `0.0.0.0` with zero authentication. The `/project/{code}/run` endpoint can trigger arbitrary command execution. While Tailscale provides network-level isolation, any process on the local machine or Tailscale network can invoke these endpoints without restriction.

## What Changes
- **BREAKING**: Bind HTTP server to `127.0.0.1` by default instead of `0.0.0.0`
- Add configurable `bind_address` field to `agents.toml` for both HTTP and gRPC
- Add shared-secret header authentication for the `/project/{code}/run` endpoint
- Make shared secret configurable via `agents.toml` or environment variable

## Impact
- Affected specs: none (no existing specs)
- Affected code: `crates/nexus-agent/src/main.rs:259,341` (bind addresses), `crates/nexus-agent/src/http_handlers.rs` (run handler auth), config parsing
- Breaking: Existing agents binding to `0.0.0.0` will need to explicitly set `bind_address = "0.0.0.0"` in config to restore previous behavior
