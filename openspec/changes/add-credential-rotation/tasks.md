# Implementation Tasks

<!-- beads:epic:nexus-e1t -->

## Core Types Batch

- [ ] [1.1] [P-1] Add `CredentialAccount`, `AccountUsage`, `UsageWindow` structs to `crates/nexus-core/src/credentials.rs` with Serialize/Deserialize [owner:engineer] [beads:nexus-aln]
- [ ] [1.2] [P-1] Add `pub mod credentials;` to `crates/nexus-core/src/lib.rs` [owner:engineer] [beads:nexus-lr2]
- [ ] [1.3] [P-1] Add `UsageCache` struct with `load()` and `save()` for `~/.config/nexus/state/usage-cache.json` persistence [owner:engineer] [beads:nexus-a14]
- [ ] [1.4] [P-2] Implement `CredentialAccount::is_expired()`, `effective_utilization()`, and `best_available(accounts)` selection algorithm [owner:engineer] [beads:nexus-lk3r]
- [ ] [1.5] [P-2] Add unit tests for `best_available` — picks lowest utilization, skips expired, returns None when all exhausted [owner:engineer] [beads:nexus-xyzy]

## Usage API Client Batch

- [ ] [2.1] [P-1] Extract Anthropic usage API client from `crates/nexus-status/src/main.rs:286-370` into `crates/nexus-core/src/credentials.rs` as `pub async fn query_usage(client: &reqwest::Client, access_token: &str) -> Result<AccountUsage>` [owner:engineer] [beads:nexus-f8vm]
- [ ] [2.2] [P-2] Add unit test for usage API response parsing (mock JSON → AccountUsage) [owner:engineer] [beads:nexus-nmm3]

## Credential Pool Service Batch

- [ ] [3.1] [P-1] Create `crates/nexus-agent/src/services/credential_pool.rs` implementing `Service` trait — startup: scan `~/.config/nexus/credentials/`, parse each JSON file, load cached usage [owner:engineer] [beads:nexus-72xw]
- [ ] [3.2] [P-1] Add file watcher (notify crate) on `~/.config/nexus/credentials/` for add/remove/modify events with 1s debounce [owner:engineer] [beads:nexus-76v3]
- [ ] [3.3] [P-1] Implement 5-minute proactive usage poll loop — iterates all accounts, calls `query_usage` per token, updates in-memory state, persists to cache file [owner:engineer] [beads:nexus-swop]
- [ ] [3.4] [P-2] Implement `poll_now()` method for on-demand fresh query (bypasses interval timer), called by interceptor [owner:engineer] [beads:nexus-vt61]
- [ ] [3.5] [P-2] Implement `swap_credential(target)` — atomic symlink replacement of `~/.claude/.credentials.json` → `target.path` [owner:engineer] [beads:nexus-junl]
- [ ] [3.6] [P-2] Handle passthrough mode — if credentials dir is empty/missing, skip all interception and polling [owner:engineer] [beads:nexus-34pq]
- [ ] [3.7] [P-2] Wire `CredentialPoolService` into `main.rs` service startup, pass shared `Arc<CredentialPool>` to socket handler [owner:engineer] [beads:nexus-8f8z]

## Rate Limit Interceptor Batch

- [ ] [4.1] [P-1] Add rate limit detection in `socket.rs` notification handler — check for "hit your limit" text or `rate_limit_event` with `utilization >= 1.0` [owner:engineer] [beads:nexus-v12j]
- [ ] [4.2] [P-1] On detection: call `pool.poll_now()`, then `pool.best_available()`, then `pool.swap_credential()`, then `dispatch_answer(session, "continue")` [owner:engineer] [beads:nexus-7arf]
- [ ] [4.3] [P-1] Implement 3-minute debounce window — after a swap, subsequent rate limit events from any session trigger only "continue" without re-querying or re-swapping [owner:engineer] [beads:nexus-l7bt]
- [ ] [4.4] [P-2] Suppress rate limit notification from TTS delivery when interception succeeds (don't announce "hit your limit" if we're auto-rotating) [owner:engineer] [beads:nexus-hubq]
- [ ] [4.5] [P-2] Handle non-tmux sessions — swap still occurs but "continue" is skipped with a warning log [owner:engineer] [beads:nexus-ohyg]

## Exhaustion Handler Batch

- [ ] [5.1] [P-1] When `best_available()` returns None, format exhaustion notification with account names, limit types, and reset times [owner:engineer] [beads:nexus-b5pm]
- [ ] [5.2] [P-1] Identify soonest-to-reset account and mark with "← next available" in the notification text [owner:engineer] [beads:nexus-sxzn]
- [ ] [5.3] [P-2] Deliver exhaustion notification via normal TTS path (not suppressed) [owner:engineer] [beads:nexus-lhq6]

## Verification Batch

- [ ] [6.1] Verify `cargo build` succeeds for all workspace crates [owner:engineer] [beads:nexus-ug4o]
- [ ] [6.2] Verify `cargo test` passes with new credential pool, usage API, and selection algorithm tests [owner:engineer] [beads:nexus-1spt]
- [ ] [6.3] Verify `cargo clippy` reports no new warnings [owner:engineer] [beads:nexus-xaa4]
- [ ] [6.4] Integration test: create 2 credential files, trigger mock rate limit, verify symlink swap occurs [owner:engineer] [beads:nexus-c4bn]
