# Implementation Tasks

<!-- beads:epic:TBD -->

## Cleanup Batch

- [ ] [1.1] [P-1] Delete 3 orphaned tmp files from crates/nexus-agent/src/ (tmp.Ivy7xTb8d2.rs, tmp.NNWJ78si7M.rs, tmp.XDxFD6ec8G.rs) [owner:engineer]
- [ ] [1.2] [P-1] Delete 3 orphaned tmp files from crates/nexus-agent/src/grpc/ (tmp.6y1l629Rep.rs, tmp.Oqhw4vwLMk.rs, tmp.wRXEchDOq1.rs) [owner:engineer]

## Verification Batch

- [ ] [2.1] Verify cargo build -p nexus-agent succeeds [owner:engineer]
- [ ] [2.2] Verify cargo test -p nexus-agent passes [owner:engineer]
- [ ] [2.3] Verify grep finds no remaining references to deleted files [owner:engineer]
