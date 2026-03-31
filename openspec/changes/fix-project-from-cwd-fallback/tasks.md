# Implementation Tasks

<!-- beads:epic:TBD -->

## API Batch

- [ ] [1.1] [P-1] Remove the "last component if short enough" fallback at `lifecycle.rs:234-239` [owner:api-engineer]
- [ ] [1.2] [P-1] Fix test `test_project_from_cwd_no_dev` to expect `""` for `/tmp` instead of `"tmp"` [owner:api-engineer]
- [ ] [1.3] [P-2] Add test cases for `/var/log`, `/usr/bin`, `/home/dev` to confirm empty string [owner:api-engineer]

## E2E Batch

- [ ] [2.1] Verify `cargo test -p nexus-core` passes with corrected assertions [owner:e2e-engineer]
- [ ] [2.2] Verify `cargo clippy` reports no new warnings [owner:e2e-engineer]
