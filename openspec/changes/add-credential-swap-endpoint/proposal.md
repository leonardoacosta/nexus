# Proposal: Add POST /credentials/swap Endpoint

## Change ID
`add-credential-swap-endpoint`

## Summary
Add a `POST /credentials/swap` HTTP endpoint that allows external callers (tmux menu scripts, CLI tools) to trigger a credential swap to a named account, using the existing `swap_credential()` and `record_swap()` infrastructure in the credential pool service.

## Context
- Extends: `crates/nexus-agent/src/http_handlers/credentials.rs` (existing `GET /credentials` handler)
- Extends: `crates/nexus-agent/src/services/credential_pool.rs` (existing `swap_credential()`, `record_swap()`, `best_available()`, `is_debounce_active()`)
- Extends: `crates/nexus-agent/src/main.rs` (route registration, lines 492–543)
- Related: `openspec/specs/credential-http-endpoint/spec.md` — covers GET endpoint, auth, TLS enforcement
- Related: `openspec/specs/credential-pool/spec.md` — covers pool management, polling, selection logic

## Motivation
The credential pool service already has full swap machinery: atomic symlink swap, debounce tracking, Sentry breadcrumbs, and DB analytics recording. However, swaps can only be triggered internally (by the rate-limit interceptor or pre-rotation logic). There is no way for an external caller — such as a tmux credential-switching menu or a CLI script — to request a swap to a specific named account. Adding `POST /credentials/swap` closes this gap with minimal new code by wiring an HTTP endpoint to the existing `swap_credential()` + `record_swap()` methods.

## Requirements

### Req-1: POST /credentials/swap endpoint
The HTTP server SHALL expose `POST /credentials/swap` which accepts a JSON body `{ "account": "<name>" }`, validates the target account, respects the debounce window, performs the swap, and returns the updated credential pool status.

### Req-2: Auth parity with existing credential endpoints
The endpoint SHALL require a valid `X-Nexus-Secret` header, consistent with all other credential endpoints.

### Req-3: Error handling
The endpoint SHALL return appropriate HTTP status codes for: account not found (404), account expired (409), debounce active (429), and swap failure (500).

## Scope
- **IN**: `SwapRequest` struct, `swap_handler` function, route registration, error cases, tests
- **OUT**: Changes to swap_credential() internals, debounce window tuning, new DB tables, TLS enforcement changes

## Impact
| Area | Change |
|------|--------|
| `crates/nexus-agent/src/http_handlers/credentials.rs` | Add `SwapRequest` struct and `swap_handler` function |
| `crates/nexus-agent/src/http_handlers/mod.rs` | Re-export `swap_handler` |
| `crates/nexus-agent/src/main.rs` | Register `POST /credentials/swap` route |

## Risks
| Risk | Mitigation |
|------|-----------|
| Concurrent swap requests could race | `swap_credential()` already uses atomic symlink swap via rename(2); debounce window prevents rapid-fire swaps |
| Debounce window blocks legitimate manual swaps | 429 response includes `retry_after_seconds` so callers can wait and retry |
| Named account may have stale usage data | Caller can poll `GET /credentials` first to check utilization before requesting swap |
