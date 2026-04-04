# Implementation Tasks

<!-- beads:epic:nexus-jo6 -->

## Core Batch

- [ ] [1.1] [P-1] Add `bind_address: String` field to `ReceiverService` struct and thread it through `new()`, `with_config()`, `with_shared_config()`, and `with_port()` constructors [owner:engineer] [beads:nexus-9if]
- [ ] [1.2] [P-1] Update `ReceiverService::start()` to use `self.bind_address` instead of hardcoded `[0, 0, 0, 0]` at service.rs:158, and fix the log message at line 160 [owner:engineer] [beads:nexus-bvg]
- [ ] [1.3] [P-1] Update `main.rs` to pass `nexus_config.bind_address.clone()` when constructing `ReceiverService::new()` at line 123 [owner:engineer] [beads:nexus-4vn]
- [ ] [1.4] [P-1] Change `ServerConfig::default()` host from `"0.0.0.0"` to `"127.0.0.1"` in `notification_config.rs:36` [owner:engineer] [beads:nexus-e5n]

## Verification Batch

- [ ] [2.1] Test ReceiverService binds to 127.0.0.1 by default when no bind_address configured [owner:engineer] [beads:nexus-2o1]
- [ ] [2.2] Test ReceiverService uses explicit bind_address when provided [owner:engineer] [beads:nexus-7vv]
- [ ] [2.3] Verify `cargo build` succeeds and `cargo test` passes across all crates [owner:engineer] [beads:nexus-s6e]
- [ ] [2.4] Update existing tests in notification_config.rs that assert `"0.0.0.0"` as default host [owner:engineer] [beads:nexus-7yy]
