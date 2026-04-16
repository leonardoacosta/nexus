# Implementation Tasks

## 1. Handler Implementation

- [ ] [1.1] Add `SwapRequest` struct with `account: String` field in `http_handlers/credentials.rs`
- [ ] [1.2] Add `SwapResponse` struct reusing `CredentialsResponse` plus a `swapped_to: String` field
- [ ] [1.3] Implement `swap_handler` async function: validate secret, parse body, look up account, check expired, check debounce, call `swap_credential()` + `record_swap()`, return updated status
- [ ] [1.4] Add error cases returning: 404 (account not found), 409 (account expired), 429 (debounce active with `retry_after_seconds`), 500 (swap_credential failure)

## 2. Route Registration

- [ ] [2.1] Re-export `swap_handler` from `http_handlers/mod.rs`
- [ ] [2.2] Register `POST /credentials/swap` route in `main.rs` alongside existing `GET /credentials`

## 3. Testing

- [ ] [3.1] Add unit tests for `swap_handler`: successful swap, account not found, account expired, debounce active
- [ ] [3.2] Add integration test: swap to a named account and verify `GET /credentials` reflects new active account
