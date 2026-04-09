# Design: Add POST /credentials/swap Endpoint

## Context

The credential pool service in `nexus-agent` manages multiple OAuth credential files and supports atomic symlink swapping between them. Swaps are currently triggered only by internal logic (rate-limit interceptor, predictive pre-rotation). External tools like tmux menu scripts have no way to request a swap to a specific account.

Stakeholders: tmux credential menu, CLI automation scripts, nexus-agent HTTP server.

## Goals / Non-Goals

Goals:
- External callers can trigger a credential swap to a specific named account via HTTP
- Reuse existing `swap_credential()` and `record_swap()` without modification
- Respect the existing 3-minute debounce window

Non-Goals:
- Changing the debounce window duration
- Adding queue/retry logic server-side for debounced requests
- Modifying `swap_credential()` internals or the atomic symlink mechanism
- Adding new DB tables or analytics beyond what `record_swap()` already captures

## Decisions

### Decision 1: POST not PUT

The swap endpoint uses POST because the operation is an action (trigger a swap), not an idempotent resource update. Calling `POST /credentials/swap` twice with the same account name while debounce is active returns 429 on the second call — the operation is not idempotent. PUT would incorrectly signal that repeating the request produces the same result.

Alternatives considered:
- PUT /credentials/active: rejected — implies idempotent "set active credential" semantics, but the swap has side effects (debounce timer reset, Sentry breadcrumb, DB analytics row) that make it non-idempotent.
- POST /credentials/{name}/swap: rejected — adds a path parameter that complicates routing and doesn't match the existing flat `/credentials` namespace.

### Decision 2: 429 for debounce, not queue

When a swap request arrives within the 3-minute debounce window, the handler returns HTTP 429 Too Many Requests with a `retry_after_seconds` field. The caller is responsible for waiting and retrying.

Server-side queuing was rejected because:
- The debounce window exists to protect against rapid credential churn, not to queue work.
- Callers (tmux scripts) are better positioned to decide whether to wait or abandon.
- Adding a queue introduces state management complexity disproportionate to the use case.

### Decision 3: Return full CredentialsResponse after swap

On success, the response includes the complete credential pool status (same shape as `GET /credentials`) plus the `swapped_to` account name. This avoids requiring callers to make a follow-up GET request to confirm the swap took effect.

Alternatives considered:
- Return only `{ "swapped_to": "account-name" }`: rejected — callers typically need the updated utilization and debounce state immediately after a swap.
- Return 204 No Content: rejected — forces a follow-up GET, adding latency for the common case.

## Risks / Trade-offs

- The handler acquires a read lock on `pool.accounts` to look up the target account, then calls `swap_credential()` which does filesystem I/O. The lock is released before the swap, so a concurrent pool refresh could theoretically remove the account between lookup and swap. In practice, account removal is rare (manual file deletion) and the symlink swap would fail gracefully with a 500 error. No mitigation needed for this edge case.
- Returning the full `CredentialsResponse` after swap means the handler does the same work as `credentials_handler`. This is acceptable — the cost is one read lock and a small struct allocation per swap, which happens at most once per 3 minutes.

## Open Questions

None — the implementation is a thin wiring layer over existing infrastructure.
