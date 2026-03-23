## 1. Fix uptime_seconds
- [x] 1.1 Added `started_at: Instant` field to `NexusAgentService`
- [x] 1.2 Compute `uptime_seconds` from `self.started_at.elapsed().as_secs()` in GetHealth handler

## 2. Validation
- [x] 2.1 Build passes, `uptime_seconds` no longer hardcoded to 0
- [x] 2.2 `cargo clippy && cargo test` — clean
