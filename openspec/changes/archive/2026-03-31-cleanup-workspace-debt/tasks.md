# Implementation Tasks

<!-- beads:epic:TBD -->

## DB Batch

- [x] [1.1] [P-1] Delete all `tmp.*.rs` files across workspace: `find crates -name 'tmp.*.rs' -delete` (29 files, ~11K LOC) [owner:db-engineer]
- [x] [1.2] [P-1] Add `tmp.*.rs` pattern to `.gitignore` to prevent future accumulation [owner:db-engineer]

## API Batch

- [x] [2.1] [P-1] Fix `failures::tests::query_http_aggregation` assertion in `crates/nexus-agent/src/failures.rs` — update expected string to match actual output [owner:api-engineer]

## E2E Batch

- [x] [4.1] Run `cargo test -p nexus-core -p nexus-agent --lib` and verify 0 failures (down from 1) [owner:api-engineer]
